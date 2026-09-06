/*
 * app.js — 页面交互层：只负责 DOM、事件和流程编排。
 * 所有裁切数学在 crop-engine.js，图片加载/绘制/导出在 image-utils.js。
 *
 * 批量架构（实现决策 8）：
 * - images[] 保存所有图片的 File 与各自完整编辑状态；解码后的图像数据
 *   只保留当前激活的一张（切走即 close 释放），避免大图撑爆内存；
 * - 切换图片 = 存回旧图状态 → 解码新图 → 恢复状态（或决策 10 自动适配比例）；
 * - 全部导出（实现决策 9）按序"静默激活"每张图导出，结束后恢复最初激活图。
 */
(function () {
  'use strict';

  var engine = new CropEngine();
  var image = null; // 当前已解码图像（loadImage 返回值 { source, width, height, close }）
  // 图片记录：{ id, name, file, thumbUrl, thumbW, thumbH, ratioText, exported, hasState, state, el }
  // state = { ratioW, ratioH, ratioLabel, ratioText, manualRatio, rotation, scale, offsetX, offsetY }
  var images = [];
  var activeId = null; // 当前激活图片的记录 id
  var idSeq = 1;
  // ratioLabel：比例标签（chips 为 "3:4"，自定义化简后为 "2x3"），用于文件名与 chip 还原；
  // ratioText：信息栏显示文本（如 "3:4"、"47:20"）
  var ratioLabel = '1:1';
  var ratioText = '1:1';
  var dpr = Math.min(window.devicePixelRatio || 1, 2);
  var switching = false; // 切图解码期间防重入
  var exporting = false; // 导出期间防重入
  // 实现决策 10：当前图是否被用户手动改过比例（手动覆盖永久优先）
  var manualRatioSet = false;
  // 实现决策 11：井字格辅助线开关，默认开启，用户偏好持久化到 localStorage
  var showGrid = localStorage.getItem('rc-grid-on') !== '0';
  // 实现决策 9：全部导出统一使用 JPG 高画质（照片批量场景最通用，quality 0.98）
  var EXPORT_ALL_MIME = 'image/jpeg';
  // 实现决策 9：用户选定的保存文件夹句柄（File System Access API，句柄存 IndexedDB）
  var saveDirHandle = null;

  var $ = function (id) {
    return document.getElementById(id);
  };

  var els = {
    stage: $('stage'),
    frameWrap: $('frameWrap'),
    canvas: $('cropCanvas'),
    emptyHint: $('emptyHint'),
    fileInput: $('fileInput'),
    selectBtn: $('selectBtn'),
    rotateBtn: $('rotateBtn'),
    resetBtn: $('resetBtn'),
    gridBtn: $('gridBtn'),
    ratioInfo: $('ratioInfo'),
    origInfo: $('origInfo'),
    outInfo: $('outInfo'),
    exportJpgBtn: $('exportJpgBtn'),
    exportPngBtn: $('exportPngBtn'),
    exportAllBtn: $('exportAllBtn'),
    saveDirBtn: $('saveDirBtn'),
    sidebar: $('sidebar'),
    thumbList: $('thumbList'),
    addImagesBtn: $('addImagesBtn'),
    customRatioInput: $('customRatioInput'),
    customApplyBtn: $('customApplyBtn'),
    zoomInput: $('zoomInput'),
    zoomApplyBtn: $('zoomApplyBtn'),
    zoomInfo: $('zoomInfo'),
    ratioRow: $('ratioRow'),
    toast: $('toast')
  };

  /* ---------- 工具栏反馈 ---------- */

  var toastTimer = null;
  function toast(msg, type) {
    els.toast.textContent = msg;
    els.toast.className = 'toast show' + (type ? ' ' + type : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      els.toast.className = 'toast';
    }, 3000);
  }

  function setButtonsEnabled(enabled) {
    els.rotateBtn.disabled = !enabled;
    els.resetBtn.disabled = !enabled;
    els.zoomInput.disabled = !enabled;
    els.zoomApplyBtn.disabled = !enabled;
    els.exportJpgBtn.disabled = !enabled;
    els.exportPngBtn.disabled = !enabled;
  }

  // 实现决策 9：全部导出按钮与"列表非空"联动，导出期间禁用
  function updateExportAllBtn() {
    els.exportAllBtn.disabled = exporting || images.length === 0;
  }

  /* ---------- IndexedDB 键值存取（实现决策 9） ----------
   * FileSystemHandle 无法存入 localStorage，改用原生 IndexedDB：
   * db 名 "ratio-craft"，store "kv"，key "saveDir"。
   */

  function openKvDb() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open('ratio-craft', 1);
      req.onupgradeneeded = function () {
        req.result.createObjectStore('kv');
      };
      req.onsuccess = function () {
        resolve(req.result);
      };
      req.onerror = function () {
        reject(req.error);
      };
    });
  }

  function kvSet(key, value) {
    return openKvDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction('kv', 'readwrite');
        tx.objectStore('kv').put(value, key);
        tx.oncomplete = function () {
          resolve();
        };
        tx.onerror = function () {
          reject(tx.error);
        };
      });
    });
  }

  function kvGet(key) {
    return openKvDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction('kv', 'readonly');
        var rq = tx.objectStore('kv').get(key);
        rq.onsuccess = function () {
          resolve(rq.result);
        };
        rq.onerror = function () {
          reject(rq.error);
        };
      });
    });
  }

  /* ---------- 保存文件夹（实现决策 9） ---------- */

  function hasFsAccess() {
    return typeof window.showDirectoryPicker === 'function';
  }

  function updateSaveDirBtn() {
    if (!saveDirHandle) {
      els.saveDirBtn.textContent = '选择保存文件夹';
      els.saveDirBtn.title = '导出时直接写入选定的文件夹（Chrome / Edge 桌面端）';
      return;
    }
    var name = saveDirHandle.name || '已选文件夹';
    // 文案截断到约 10 字符，全名放 title
    var short = name.length > 10 ? name.slice(0, 9) + '…' : name;
    els.saveDirBtn.textContent = short;
    els.saveDirBtn.title = '保存到：' + name;
  }

  // 页面加载时异步恢复上次授权的文件夹；句柄失效（文件夹被删等）时静默回退
  function initSaveDir() {
    els.saveDirBtn.hidden = false; // 仅支持 File System Access 的浏览器显示该按钮
    kvGet('saveDir')
      .then(function (handle) {
        if (!handle) return;
        // 探测句柄是否仍可用（用户可能已删除该文件夹）
        return Promise.resolve()
          .then(function () {
            return handle.queryPermission({ mode: 'readwrite' });
          })
          .then(function () {
            saveDirHandle = handle;
            updateSaveDirBtn();
          })
          .catch(function () {
            saveDirHandle = null; // 句柄失效：丢弃并保持默认文案
            updateSaveDirBtn();
          });
      })
      .catch(function () {
        /* IndexedDB 读取失败：忽略，走默认下载行为 */
      });
  }

  els.saveDirBtn.addEventListener('click', function () {
    if (!hasFsAccess() || exporting) return;
    window
      .showDirectoryPicker({ mode: 'readwrite' })
      .then(function (handle) {
        saveDirHandle = handle;
        updateSaveDirBtn();
        kvSet('saveDir', handle).catch(function () {
          /* 持久化失败不影响本次会话使用 */
        });
        toast('已选择保存文件夹：' + (handle.name || ''), 'ok');
      })
      .catch(function (err) {
        if (err && err.name === 'AbortError') return; // 用户取消：静默
        toast('选择文件夹失败：' + (err && err.message ? err.message : err), 'error');
      });
  });

  // 写入前检查/申请读写权限（导出点击是用户手势，可以弹授权框）
  function ensureSavePermission() {
    return Promise.resolve()
      .then(function () {
        return saveDirHandle.queryPermission({ mode: 'readwrite' });
      })
      .then(function (perm) {
        if (perm === 'granted') return true;
        if (perm === 'prompt') {
          return saveDirHandle
            .requestPermission({ mode: 'readwrite' })
            .then(function (p) {
              return p === 'granted';
            });
        }
        return false; // denied
      })
      .catch(function () {
        return false;
      });
  }

  // 保存 Blob：有授权文件夹则直接写入，否则（或写入失败时）回退普通下载
  function saveBlob(blob, filename) {
    if (!saveDirHandle) {
      RatioCraftUtils.downloadBlob(blob, filename);
      return Promise.resolve(false);
    }
    return ensureSavePermission().then(function (ok) {
      if (!ok) {
        RatioCraftUtils.downloadBlob(blob, filename);
        toast('未获得文件夹写入权限，已改为浏览器下载', 'error');
        return false;
      }
      return saveDirHandle
        .getFileHandle(filename, { create: true })
        .then(function (fileHandle) {
          return fileHandle.createWritable();
        })
        .then(function (writable) {
          return writable.write(blob).then(function () {
            return writable.close();
          });
        })
        .then(function () {
          return true;
        })
        .catch(function () {
          // 句柄失效 / 写入失败（如文件夹被删）：回退普通下载
          RatioCraftUtils.downloadBlob(blob, filename);
          toast('写入保存文件夹失败，已改为浏览器下载', 'error');
          return false;
        });
    });
  }

  /* ---------- 布局与渲染 ---------- */

  // 依据可用空间和当前比例计算固定裁切框尺寸，并同步到引擎与画布
  function layoutFrame() {
    var cs = window.getComputedStyle(els.stage);
    var availW = els.stage.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    var availH = els.stage.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    if (availW <= 40 || availH <= 40) return;

    var ratio = engine.ratioW / engine.ratioH;
    var fw = availW;
    var fh = fw / ratio;
    if (fh > availH) {
      fh = availH;
      fw = fh * ratio;
    }
    fw = Math.floor(fw);
    fh = Math.floor(fh);

    els.frameWrap.style.width = fw + 'px';
    els.frameWrap.style.height = fh + 'px';
    els.canvas.style.width = fw + 'px';
    els.canvas.style.height = fh + 'px';
    els.canvas.width = Math.round(fw * dpr);
    els.canvas.height = Math.round(fh * dpr);

    engine.setFrameSize(fw, fh);
    render();
    updateInfo();
  }

  // 实现决策 11：在裁切框内绘制井字格三等分辅助线（仅预览层，绝不进入导出图像）
  function drawGridLines(ctx) {
    var w = engine.frameW;
    var h = engine.frameH;
    // 坐标对齐到 0.5 像素，保证 1px 线在屏幕上清晰不虚
    var xs = [Math.round(w / 3) + 0.5, Math.round((2 * w) / 3) + 0.5];
    var ys = [Math.round(h / 3) + 0.5, Math.round((2 * h) / 3) + 0.5];
    ctx.lineWidth = 1; // CSS 像素（ctx 已按 dpr 缩放）
    // 第一遍：深色投影（偏移 0.5px），保证亮色图片上可见
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.35)';
    ctx.beginPath();
    xs.forEach(function (x) {
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, h);
    });
    ys.forEach(function (y) {
      ctx.moveTo(0, y + 0.5);
      ctx.lineTo(w, y + 0.5);
    });
    ctx.stroke();
    // 第二遍：白色半透明主体线，保证暗色图片上可见
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.beginPath();
    xs.forEach(function (x) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
    });
    ys.forEach(function (y) {
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
    });
    ctx.stroke();
  }

  // 预览绘制：与导出共用同一套变换（image-utils.drawSource）
  function render() {
    if (!image) return;
    var ctx = els.canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, engine.frameW, engine.frameH);
    RatioCraftUtils.drawSource(ctx, image.source, engine.getExportParams());
    if (showGrid) drawGridLines(ctx); // 井字格仅叠加在预览上，导出走 exportImage，不含辅助线
  }

  // 清空预览画布（回到无图空状态时使用）
  function clearCanvas() {
    var ctx = els.canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, els.canvas.width, els.canvas.height);
  }

  function updateInfo() {
    if (!image) {
      els.origInfo.textContent = '原图：–';
      els.outInfo.textContent = '输出：–';
      els.zoomInfo.textContent = '缩放：–';
      els.outInfo.classList.remove('warn');
      return;
    }
    els.origInfo.textContent = '原图：' + engine.imgW + ' × ' + engine.imgH;
    var out = engine.outputSize();
    var over = RatioCraftUtils.isOverCanvasLimit(out.w, out.h);
    els.outInfo.textContent = '输出：' + out.w + ' × ' + out.h + (over ? '（超出画布上限，导出可能失败）' : '');
    els.outInfo.classList.toggle('warn', over);
    // 当前缩放倍数：相对 cover 状态（1.00× = 默认铺满）
    var rel = engine.scale / engine.minScale();
    els.zoomInfo.textContent = '缩放：' + (rel >= 10 ? rel.toFixed(1) : rel.toFixed(2)) + '×';
  }

  /* ---------- 比例 ---------- */

  function clearActiveChips() {
    els.ratioRow.querySelectorAll('.ratio-chip').forEach(function (chip) {
      chip.classList.remove('active');
    });
  }

  // 实现决策 1：切换比例后重置到默认铺满状态
  function applyRatio(w, h, label, simplifiedText) {
    engine.setRatio(w, h);
    ratioLabel = label;
    ratioText = simplifiedText || label;
    els.ratioInfo.textContent = '比例：' + ratioText;
    layoutFrame();
    engine.resetView();
    render();
    updateInfo();
  }

  // 实现决策 10：按图片实际宽高自动检测比例并直接应用（从未编辑过的图走这里）。
  // silent 为 true 时用于批量导出的静默激活，不弹单张提示。
  function autoApplyRatio(loaded, silent) {
    manualRatioSet = false;
    var detected = RatioCraftUtils.detectRatio(loaded.width, loaded.height);
    if (detected) {
      var autoText = detected.w + ':' + detected.h;
      // applyRatio 内部已处理 layoutFrame / render / updateInfo，无需再单独调用
      applyRatio(detected.w, detected.h, detected.w + 'x' + detected.h, autoText);
      // 同步比例 chip 选中态：归入预设时高亮对应 chip，否则清空（与 applyCustomRatio 行为一致）
      clearActiveChips();
      if (detected.snapped) {
        var matched = els.ratioRow.querySelector('.ratio-chip[data-ratio="' + autoText + '"]');
        if (matched) matched.classList.add('active');
      }
      if (!silent) toast('已自动应用原图比例 ' + autoText, 'ok');
    } else {
      layoutFrame(); // 含 render + updateInfo（仅未自动应用比例时需要）
    }
  }

  els.ratioRow.querySelectorAll('.ratio-chip').forEach(function (chip) {
    chip.addEventListener('click', function () {
      if (switching || exporting) return; // 切图 / 批量导出期间禁止改动
      // 实现决策 10：手动选择比例后，该图记住手动选择，不再自动跳回原图比例
      manualRatioSet = true;
      clearActiveChips();
      chip.classList.add('active');
      var parts = chip.dataset.ratio.split(':');
      applyRatio(Number(parts[0]), Number(parts[1]), chip.dataset.ratio);
    });
  });

  function applyCustomRatio() {
    if (switching || exporting) return;
    var text = els.customRatioInput.value;
    if (!text.trim()) return; // 空输入静默忽略（例如只是路过输入框）
    var parsed = RatioCraftUtils.parseRatioInput(text);
    if (!parsed) {
      els.customRatioInput.classList.add('invalid');
      toast('比例格式应为 数字:数字，例如 6:9', 'error');
      return;
    }
    els.customRatioInput.classList.remove('invalid');
    // 实现决策 10：手动提交自定义比例同样视为"手动改过比例"
    manualRatioSet = true;
    var simp = RatioCraftUtils.simplifyRatio(parsed.w, parsed.h);
    clearActiveChips();
    applyRatio(parsed.w, parsed.h, simp.w + 'x' + simp.h, simp.w + ':' + simp.h);
    toast('已应用自定义比例 ' + simp.w + ':' + simp.h, 'ok');
  }

  els.customApplyBtn.addEventListener('click', applyCustomRatio);
  els.customRatioInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') applyCustomRatio();
  });
  els.customRatioInput.addEventListener('input', function () {
    els.customRatioInput.classList.remove('invalid');
  });
  els.customRatioInput.addEventListener('blur', function () {
    if (els.customRatioInput.value.trim()) applyCustomRatio();
  });

  /* ---------- 每图状态的存回与恢复（实现决策 8） ---------- */

  function findRecord(id) {
    for (var i = 0; i < images.length; i++) {
      if (images[i].id === id) return images[i];
    }
    return null;
  }

  // 把当前激活图的完整编辑状态存回其记录（切图前、导出前调用）。
  // 缩放/位置以"框无关"形式保存（实现决策 12）：相对倍数 rel + 框中心对应的
  // 图像内容点。工具栏内容变化会导致框尺寸改变，绝对像素值在恢复时会失真。
  function saveActiveState() {
    if (activeId === null || !engine.hasImage()) return;
    var rec = findRecord(activeId);
    if (!rec) return;
    rec.hasState = true;
    rec.state = {
      ratioW: engine.ratioW,
      ratioH: engine.ratioH,
      ratioLabel: ratioLabel,
      ratioText: ratioText,
      manualRatio: manualRatioSet,
      rotation: engine.rotation,
      rel: engine.scale / engine.minScale(),
      cx: (engine.frameW / 2 - engine.offsetX) / engine.scale,
      cy: (engine.frameH / 2 - engine.offsetY) / engine.scale
    };
  }

  // 切回一张编辑过的图：按保存顺序还原比例 → 裁切框形状 → 缩放/位移 → UI。
  // rel + 中心内容点按恢复时的框尺寸重新换算（实现决策 12），构图精确还原。
  function restoreRecordState(rec) {
    var st = rec.state;
    manualRatioSet = st.manualRatio;
    engine.rotation = st.rotation;
    engine.setRatio(st.ratioW, st.ratioH);
    layoutFrame(); // 裁切框形状跟随该图比例
    engine.scale = engine.clampScale(engine.minScale() * st.rel);
    engine.offsetX = engine.frameW / 2 - st.cx * engine.scale;
    engine.offsetY = engine.frameH / 2 - st.cy * engine.scale;
    engine.clampOffsets();
    ratioLabel = st.ratioLabel;
    ratioText = st.ratioText;
    els.ratioInfo.textContent = '比例：' + st.ratioText;
    // 同步比例 chips：手动点过 chips 的图按 ratioLabel（"3:4"）匹配；
    // 自动适配归入预设的图按 ratioText（"4:3"）匹配；自定义/未归拢比例无匹配即清空
    clearActiveChips();
    var chipKey = st.manualRatio ? st.ratioLabel : st.ratioText;
    var chip = els.ratioRow.querySelector('.ratio-chip[data-ratio="' + chipKey + '"]');
    if (chip) chip.classList.add('active');
    render();
    updateInfo();
  }

  // 删光图片后恢复初始空 UI（不调用 setImage，直接清空引擎与界面）
  function resetToEmpty() {
    activeId = null;
    if (image && image.close) image.close();
    image = null;
    manualRatioSet = false;
    ratioLabel = '1:1';
    ratioText = '1:1';
    engine.imgW = 0;
    engine.imgH = 0;
    engine.rotation = 0;
    engine.setRatio(1, 1);
    engine.scale = 1;
    engine.offsetX = 0;
    engine.offsetY = 0;
    els.ratioInfo.textContent = '比例：1:1';
    clearActiveChips();
    layoutFrame(); // 回到默认 1:1 空框（render 在无图时直接返回）
    clearCanvas();
    els.emptyHint.classList.remove('hidden');
    setButtonsEnabled(false);
    updateInfo();
    updateSidebarVisibility();
    updateExportAllBtn();
  }

  /* ---------- 侧边栏（实现决策 8） ---------- */

  function updateSidebarVisibility() {
    var empty = images.length === 0;
    var changed = els.sidebar.classList.contains('hidden') !== empty;
    els.sidebar.classList.toggle('hidden', empty);
    return changed;
  }

  function updateSidebarActive() {
    images.forEach(function (rec) {
      if (rec.el) rec.el.classList.toggle('active', rec.id === activeId);
    });
  }

  function updateThumbExported(rec) {
    if (rec.el) {
      var mark = rec.el.querySelector('.thumb-exported');
      if (mark) mark.hidden = !rec.exported;
    }
  }

  // 构建单个缩略图 DOM 并挂到列表；img onload 时记录尺寸并生成比例角标
  function appendThumb(rec) {
    var item = document.createElement('div');
    item.className = 'thumb-item';
    item.title = rec.name;
    item.setAttribute('data-id', String(rec.id));

    var img = document.createElement('img');
    img.className = 'thumb-img';
    img.alt = rec.name;
    img.src = rec.thumbUrl;
    img.onload = function () {
      rec.thumbW = img.naturalWidth;
      rec.thumbH = img.naturalHeight;
      // 比例角标：仅用于"扫一眼知道比例"，不影响裁切（真正生效在激活时的决策 10）
      var det = RatioCraftUtils.detectRatio(rec.thumbW, rec.thumbH);
      if (det) {
        rec.ratioText = det.w + ':' + det.h;
        badge.textContent = rec.ratioText;
      } else {
        badge.hidden = true;
      }
    };

    var badge = document.createElement('span');
    badge.className = 'thumb-ratio';

    var mark = document.createElement('span');
    mark.className = 'thumb-exported';
    mark.textContent = '✓';
    mark.hidden = !rec.exported;

    var del = document.createElement('button');
    del.className = 'thumb-del';
    del.type = 'button';
    del.textContent = '×';
    del.title = '删除这张图片';
    del.addEventListener('click', function (e) {
      e.stopPropagation(); // 不要触发缩略图的激活
      removeImage(rec.id);
    });

    item.addEventListener('click', function () {
      activateImage(rec.id);
    });

    item.appendChild(img);
    item.appendChild(badge);
    item.appendChild(mark);
    item.appendChild(del);
    rec.el = item;
    els.thumbList.appendChild(item);
  }

  // 删除图片：直接删（无二次确认，误删可重新拖入）
  function removeImage(id) {
    if (switching || exporting) return; // 切图 / 批量导出期间禁止删除，避免状态错乱
    var idx = -1;
    for (var i = 0; i < images.length; i++) {
      if (images[i].id === id) {
        idx = i;
        break;
      }
    }
    if (idx < 0) return;
    var rec = images[idx];
    URL.revokeObjectURL(rec.thumbUrl);
    if (rec.el && rec.el.parentNode) rec.el.parentNode.removeChild(rec.el);
    images.splice(idx, 1);

    if (id === activeId) {
      // 删的是激活图：优先激活相邻一张（先取后面一张，没有则取前面一张）
      var neighbor = images[idx] || images[idx - 1];
      if (neighbor) {
        activeId = null; // 强制 activateImage 走完整流程（否则 id === activeId 会直接 return）
        activateImage(neighbor.id);
      } else {
        resetToEmpty(); // 没有相邻图：清空引擎与界面，回到空提示布局
        return;
      }
    }
    var changed = updateSidebarVisibility();
    if (changed) layoutFrame(); // 侧边栏显隐导致预览区尺寸变化（决策 12：构图保持）
    updateExportAllBtn();
  }

  /* ---------- 多文件入口（实现决策 8） ---------- */

  function createRecord(file) {
    return {
      id: idSeq++,
      name: file.name || '粘贴图片 ' + idSeq,
      file: file,
      thumbUrl: URL.createObjectURL(file),
      thumbW: 0,
      thumbH: 0,
      ratioText: '',
      exported: false,
      hasState: false,
      state: null,
      el: null
    };
  }

  // 所有入口（选择 / 拖拽 / 粘贴）统一汇入这里；只收 image/* 类型
  function addFiles(fileList) {
    var list = Array.prototype.slice.call(fileList || []);
    var added = [];
    list.forEach(function (f) {
      if (f && /^image\//.test(f.type)) added.push(f);
    });
    if (!added.length) {
      toast('没有可识别的图片文件', 'error'); // 全部被过滤（空列表）
      return;
    }
    var firstNewId = null;
    added.forEach(function (f) {
      var rec = createRecord(f);
      images.push(rec);
      appendThumb(rec);
      if (firstNewId === null) firstNewId = rec.id;
    });
    var changed = updateSidebarVisibility();
    updateExportAllBtn();
    if (changed) layoutFrame(); // 侧边栏首次出现导致预览区变窄（决策 12：构图保持）
    if (activeId === null) {
      activateImage(firstNewId); // 此前无激活图 → 自动激活第一张新图
    } else {
      toast('已添加 ' + added.length + ' 张图片', 'ok'); // 已有激活图 → 保持不动
    }
  }

  els.addImagesBtn.addEventListener('click', function () {
    els.fileInput.click();
  });
  els.selectBtn.addEventListener('click', function () {
    els.fileInput.click();
  });
  els.emptyHint.addEventListener('click', function () {
    els.fileInput.click();
  });
  els.fileInput.addEventListener('change', function () {
    addFiles(els.fileInput.files);
    els.fileInput.value = ''; // 允许重复选择同一文件
  });

  // 拖拽（支持多文件）
  ['dragenter', 'dragover'].forEach(function (ev) {
    els.stage.addEventListener(ev, function (e) {
      e.preventDefault();
      els.stage.classList.add('dragging');
    });
  });
  ['dragleave', 'drop'].forEach(function (ev) {
    els.stage.addEventListener(ev, function (e) {
      e.preventDefault();
      els.stage.classList.remove('dragging');
    });
  });
  els.stage.addEventListener('drop', function (e) {
    var files = e.dataTransfer && e.dataTransfer.files;
    if (files && files.length) addFiles(files);
  });

  // 粘贴（支持多文件）
  document.addEventListener('paste', function (e) {
    var files = e.clipboardData && e.clipboardData.files;
    if (files && files.length) addFiles(files);
  });

  /* ---------- 激活与切换图片（实现决策 8） ---------- */

  // 切换到指定记录：存回旧图状态 → 解码新图（旧图在新图解码成功后才释放，
  // 失败时保持原激活图不变）→ 恢复状态或自动适配比例。
  // silent 为 true 用于批量导出的静默激活（不弹加载/适配提示）。
  function switchToRecord(rec, silent) {
    saveActiveState(); // 先把当前激活图的状态存回其记录
    return RatioCraftUtils.loadImage(rec.file)
      .then(function (loaded) {
        if (image && image.close) image.close(); // 释放旧图解码数据（内存策略）
        image = loaded;
        activeId = rec.id;
        engine.setImage(loaded.width, loaded.height); // 重置 rotation 并 resetView
        els.emptyHint.classList.add('hidden');
        if (rec.hasState) {
          restoreRecordState(rec); // a. 编辑过：原样恢复比例/缩放/位置/旋转
        } else {
          autoApplyRatio(loaded, silent); // b. 从未编辑过：走决策 10 自动适配
        }
        updateSidebarActive();
        updateExportAllBtn();
        setButtonsEnabled(true); // 新图就绪，解锁旋转/重置/倍数输入/导出按钮
        return true;
      })
      .catch(function (err) {
        if (!silent) toast(err.message || '图片加载失败', 'error');
        return false; // 失败：旧 image 未被 close，原激活图保持不变
      });
  }

  // 用户点击缩略图激活某张图；解码期间再点忽略（switching 防重入）
  function activateImage(id) {
    if (id === activeId) return; // 已是当前图
    if (switching || exporting) return;
    var rec = findRecord(id);
    if (!rec) return;
    switching = true;
    toast('加载图片中…');
    switchToRecord(rec, false).finally(function () {
      switching = false;
    });
  }

  /* ---------- 操作 ---------- */

  els.rotateBtn.addEventListener('click', function () {
    if (!image || switching || exporting) return;
    engine.rotate90(); // 实现决策 2：转图片不转框，旋转后重置视图
    render();
    updateInfo();
  });

  els.resetBtn.addEventListener('click', function () {
    if (!image || switching || exporting) return;
    engine.resetView();
    render();
    updateInfo();
  });

  // 井字格开关（实现决策 11）：不受 setButtonsEnabled 控制，无图时也可切换；
  // 无图时 render 直接 return，不会画线
  els.gridBtn.addEventListener('click', function () {
    showGrid = !showGrid;
    localStorage.setItem('rc-grid-on', showGrid ? '1' : '0');
    els.gridBtn.classList.toggle('active', showGrid);
    render();
  });

  /* ---------- 精准倍数缩放（实现决策 7） ---------- */

  // 绝对倍数语义（实现决策 7）：factor 相对初始铺满状态（cover，即 1.00×），
  // 而非当前缩放相乘——输入 3 就是 cover 的 3 倍，无论当前处于几倍。
  // 锚点为裁切框中心；上限仍为 16 倍 cover、下限为 cover
  function applyZoomFactor() {
    if (!image || switching || exporting) return;
    var text = els.zoomInput.value;
    if (!text.trim()) return;
    var factor = parseFloat(text);
    if (!isFinite(factor) || factor <= 0) {
      els.zoomInput.classList.add('invalid');
      toast('倍数应为正数，例如 1.2 或 2', 'error');
      return;
    }
    els.zoomInput.classList.remove('invalid');
    var before = engine.scale;
    engine.setAbsoluteZoom(factor, engine.frameW / 2, engine.frameH / 2);
    render();
    updateInfo();
    if (engine.scale === before) {
      toast('已达到缩放上限，无法再' + (factor > 1 ? '放大' : '缩小'));
    }
  }

  els.zoomApplyBtn.addEventListener('click', applyZoomFactor);
  els.zoomInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') applyZoomFactor();
  });
  els.zoomInput.addEventListener('input', function () {
    els.zoomInput.classList.remove('invalid');
  });
  els.zoomInput.addEventListener('blur', function () {
    if (els.zoomInput.value.trim()) applyZoomFactor();
  });

  /* ---------- 指针交互（鼠标 + 触摸统一） ---------- */

  var pointers = new Map(); // pointerId -> {x, y}（相对画布）
  var lastPan = null;
  var pinch = null; // { dist0, start, s0, ox0, oy0 }

  function pointFromEvent(e) {
    var rect = els.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function initPinch() {
    var arr = Array.from(pointers.values());
    if (arr.length < 2) return;
    pinch = {
      dist0: Math.hypot(arr[0].x - arr[1].x, arr[0].y - arr[1].y),
      start: { x: (arr[0].x + arr[1].x) / 2, y: (arr[0].y + arr[1].y) / 2 },
      s0: engine.scale,
      ox0: engine.offsetX,
      oy0: engine.offsetY
    };
  }

  els.canvas.addEventListener('pointerdown', function (e) {
    if (!image) return;
    e.preventDefault();
    els.canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, pointFromEvent(e));
    if (pointers.size === 1) {
      lastPan = pointFromEvent(e);
      pinch = null;
    } else if (pointers.size === 2) {
      lastPan = null;
      initPinch();
    }
  });

  els.canvas.addEventListener('pointermove', function (e) {
    if (!pointers.has(e.pointerId)) return;
    var pt = pointFromEvent(e);
    pointers.set(e.pointerId, pt);

    if (pointers.size === 1 && lastPan) {
      engine.pan(pt.x - lastPan.x, pt.y - lastPan.y);
      lastPan = pt;
      render();
      updateInfo();
    } else if (pointers.size === 2 && pinch && pinch.dist0 > 0) {
      var arr = Array.from(pointers.values());
      var dist = Math.hypot(arr[0].x - arr[1].x, arr[0].y - arr[1].y);
      var mid = { x: (arr[0].x + arr[1].x) / 2, y: (arr[0].y + arr[1].y) / 2 };
      engine.pinchTo((pinch.s0 * dist) / pinch.dist0, pinch.start, mid, pinch.s0, pinch.ox0, pinch.oy0);
      render();
      updateInfo();
    }
  });

  function releasePointer(e) {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    if (pointers.size === 1) {
      // 从双指回到单指：以剩下的指头为新的拖动锚点
      var remaining = Array.from(pointers.values())[0];
      lastPan = remaining;
      pinch = null;
    } else if (pointers.size === 0) {
      lastPan = null;
      pinch = null;
    }
  }

  els.canvas.addEventListener('pointerup', releasePointer);
  els.canvas.addEventListener('pointercancel', releasePointer);

  // 滚轮缩放：以光标为锚点
  els.canvas.addEventListener(
    'wheel',
    function (e) {
      if (!image) return;
      e.preventDefault();
      var pt = pointFromEvent(e);
      engine.zoomAt(Math.exp(-e.deltaY * 0.0015), pt.x, pt.y);
      render();
      updateInfo();
    },
    { passive: false }
  );

  /* ---------- 导出（实现决策 9） ---------- */

  // 统一导出文件名：原名去扩展名_比例_宽x高.扩展名，如 photo_3x4_1500x2000.jpg。
  // 必须在该图处于激活状态（engine 即该图）时调用。
  function buildExportName(rec, ext) {
    var base = String((rec && rec.name) || 'image').replace(/\.[^.\/\\]+$/, '');
    var out = engine.outputSize();
    var ratioPart = ratioLabel.replace(/:/g, 'x'); // "3:4" → "3x4"，自定义已是 "2x3"
    return base + '_' + ratioPart + '_' + out.w + 'x' + out.h + '.' + ext;
  }

  function doExport(mimeType) {
    if (!image || exporting || switching) return;
    var rec = findRecord(activeId);
    var params = engine.getExportParams();
    if (RatioCraftUtils.isOverCanvasLimit(params.width, params.height)) {
      toast(
        '输出 ' + params.width + ' × ' + params.height +
        ' 超出当前浏览器画布上限，无法导出。可适当放大图片（减小输出面积）后重试。',
        'error'
      );
      return;
    }
    exporting = true;
    els.exportJpgBtn.disabled = true;
    els.exportPngBtn.disabled = true;
    els.exportAllBtn.disabled = true;
    saveActiveState(); // 导出前把最新构图存回记录，保证状态与导出结果一致
    var ext = mimeType === 'image/jpeg' ? 'jpg' : 'png';
    RatioCraftUtils.exportImage(
      image,
      params,
      mimeType,
      mimeType === 'image/jpeg' ? 0.98 : undefined
    )
      .then(function (blob) {
        return saveBlob(blob, buildExportName(rec, ext));
      })
      .then(function () {
        if (rec) {
          rec.exported = true; // 单张导出成功也置小勾
          updateThumbExported(rec);
        }
        toast('已导出 ' + params.width + ' × ' + params.height + ' ' + ext.toUpperCase(), 'ok');
      })
      .catch(function (err) {
        toast(err.message || '导出失败', 'error');
      })
      .finally(function () {
        exporting = false;
        setButtonsEnabled(true);
        updateExportAllBtn();
      });
  }

  els.exportJpgBtn.addEventListener('click', function () {
    doExport('image/jpeg');
  });
  els.exportPngBtn.addEventListener('click', function () {
    doExport('image/png');
  });

  // 全部导出（实现决策 9）：按每张图各自记住的状态依次静默激活并导出。
  // 注意：Promise 链中索引递增，images 在导出期间不可增删（removeImage 有守卫）。
  function exportAll() {
    if (exporting || switching) return;
    if (!images.length) return;
    exporting = true;
    els.exportJpgBtn.disabled = true;
    els.exportPngBtn.disabled = true;
    els.exportAllBtn.disabled = true;
    els.saveDirBtn.disabled = true;
    setButtonsEnabled(false); // 批量导出期间锁定预览操作，避免中途改动状态
    saveActiveState(); // 先把当前激活图状态存回记录
    var originalId = activeId;
    var failures = [];
    var index = 0;
    var total = images.length;

    function next() {
      if (index >= total) {
        finishExportAll(originalId, failures, total);
        return;
      }
      var rec = images[index];
      toast('正在导出 ' + (index + 1) + '/' + total + '…');
      switchToRecord(rec, true)
        .then(function (ok) {
          if (!ok) {
            failures.push(rec.name + '（图片加载失败）');
            return null;
          }
          var params = engine.getExportParams();
          if (RatioCraftUtils.isOverCanvasLimit(params.width, params.height)) {
            failures.push(rec.name + '（输出 ' + params.width + '×' + params.height + ' 超出画布上限）');
            return null;
          }
          return RatioCraftUtils.exportImage(
            image,
            params,
            EXPORT_ALL_MIME,
            EXPORT_ALL_MIME === 'image/jpeg' ? 0.98 : undefined
          )
            .then(function (blob) {
              return saveBlob(blob, buildExportName(rec, 'jpg'));
            })
            .then(function () {
              rec.exported = true;
              updateThumbExported(rec);
            })
            .catch(function (err) {
              failures.push(rec.name + '（' + (err && err.message ? err.message : '导出失败') + '）');
            });
        })
        .then(function () {
          index++;
          next();
        });
    }
    next();
  }

  function finishExportAll(originalId, failures, total) {
    var okCount = total - failures.length;
    if (failures.length) {
      toast(
        '已导出 ' + okCount + ' 张，' + failures.length + ' 张失败（' + failures.join('；') + '）',
        okCount ? undefined : 'error'
      );
    } else {
      toast('已导出 ' + okCount + ' 张', 'ok');
    }
    // 恢复激活最初那张图（重新解码并还原状态）
    var restoreRec = originalId !== null ? findRecord(originalId) : null;
    var unlock = function () {
      exporting = false;
      els.saveDirBtn.disabled = false;
      updateExportAllBtn();
      setButtonsEnabled(true);
    };
    if (restoreRec && restoreRec.id !== activeId) {
      switchToRecord(restoreRec, true).finally(unlock);
    } else {
      unlock();
    }
  }

  els.exportAllBtn.addEventListener('click', exportAll);

  /* ---------- 初始化 ---------- */

  window.addEventListener('resize', layoutFrame);
  setButtonsEnabled(false);
  updateExportAllBtn();
  els.gridBtn.classList.toggle('active', showGrid); // 同步井字格按钮选中态
  layoutFrame();
  if (hasFsAccess()) initSaveDir(); // 不支持 File System Access 的浏览器保持按钮隐藏
})();
