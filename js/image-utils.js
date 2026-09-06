/*
 * image-utils.js — 图片加载 / 变换绘制 / 导出 / 比例解析
 *
 * 与 crop-engine.js 的约定配套：
 * - drawSource 接收 engine.getExportParams() 的结果；
 * - 预览和导出共用同一套变换数学，保证"所见即所得"；
 * - 导出画布按原图像素尺寸创建，与预览分辨率无关（Preview ≠ Export）。
 */
(function (global) {
  'use strict';

  var utils = {};

  /*
   * 加载本地图片文件，返回 { source, width, height, close() }。
   * 优先 createImageBitmap 并显式要求应用 EXIF 方向（实现决策 4），
   * 避免 Canvas 导出时横竖颠倒；回退到 <img>（现代浏览器解码时默认转正）。
   * 调用方在替换图片时应调用 close() 释放资源。
   */
  utils.loadImage = function (file) {
    if (typeof window.createImageBitmap === 'function') {
      return window
        .createImageBitmap(file, { imageOrientation: 'from-image' })
        .then(function (bitmap) {
          return {
            source: bitmap,
            width: bitmap.width,
            height: bitmap.height,
            close: function () {
              if (typeof bitmap.close === 'function') bitmap.close();
            }
          };
        })
        .catch(function () {
          return loadImageViaImg(file);
        });
    }
    return loadImageViaImg(file);
  };

  function loadImageViaImg(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var el = new Image();
      el.onload = function () {
        resolve({
          source: el,
          width: el.naturalWidth,
          height: el.naturalHeight,
          close: function () {
            URL.revokeObjectURL(url);
          }
        });
      };
      el.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error('图片解码失败，文件可能已损坏或格式不受支持'));
      };
      el.src = url;
    });
  }

  /*
   * 把完整原图按 { scale, offsetX, offsetY, rotation } 变换后绘制到 ctx。
   * ctx 此前的变换决定坐标系：预览时先乘 dpr，导出时为恒等（1:1 像素）。
   *
   * 旋转 90° 顺时针的目标映射是 (x, y) → (imgH − y, x)，即"先旋转、后平移"。
   * Canvas 中后写的变换先作用于绘制的点，因此代码顺序必须是先 translate 再 rotate：
   *   r=90:  translate(imgH, 0)     rotate(π/2)
   *   r=180: translate(imgW, imgH)  rotate(π)
   *   r=270: translate(0, imgW)     rotate(3π/2)
   * 这样旋转后的图片左上角恰好落在原点，与 crop-engine 的坐标约定一致。
   */
  utils.drawSource = function (ctx, source, p) {
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = 'high';
    ctx.translate(p.offsetX, p.offsetY);
    ctx.scale(p.scale, p.scale);
    var r = ((p.rotation % 360) + 360) % 360;
    if (r === 90) {
      ctx.translate(p.imgH, 0);
      ctx.rotate(Math.PI / 2);
    } else if (r === 180) {
      ctx.translate(p.imgW, p.imgH);
      ctx.rotate(Math.PI);
    } else if (r === 270) {
      ctx.translate(0, p.imgW);
      ctx.rotate((3 * Math.PI) / 2);
    }
    ctx.drawImage(source, 0, 0);
    ctx.restore();
  };

  /*
   * 拼图：把一张图的"裁切成品"按 cover 铺满绘制到格子里（无留白）。
   * cell = { x, y, w, h } 格子在拼图画布上的矩形；
   * crop  = { sx, sy, cropW, cropH, rotation } 裁切区域，坐标在 source 的
   *         （已转正）像素系中，cropW/cropH 是裁切区域宽高；
   * imgW/imgH = source 的像素尺寸（已转正）。
   *
   * 变换链：格子中心 ← ×coverScale ← 平移到裁切区域中心 ← 旋转映射到原图。
   * coverScale = max(cellW/cropW, cellH/cropH) 保证格子被完全铺满，
   * 超出格子的部分由调用方提前 clip 或天然越界裁掉。
   */
  utils.drawCropIntoRect = function (ctx, source, cell, crop, imgW, imgH, clip) {
    ctx.save();
    if (clip) {
      ctx.beginPath();
      ctx.rect(cell.x, cell.y, cell.w, cell.h);
      ctx.clip();
    }
    var s = Math.max(cell.w / crop.cropW, cell.h / crop.cropH);
    ctx.translate(cell.x + cell.w / 2, cell.y + cell.h / 2);
    ctx.scale(s, s);
    ctx.translate(-(crop.sx + crop.cropW / 2), -(crop.sy + crop.cropH / 2));
    var r = ((crop.rotation % 360) + 360) % 360;
    if (r === 90) {
      ctx.translate(imgH, 0);
      ctx.rotate(Math.PI / 2);
    } else if (r === 180) {
      ctx.translate(imgW, imgH);
      ctx.rotate(Math.PI);
    } else if (r === 270) {
      ctx.translate(0, imgW);
      ctx.rotate((3 * Math.PI) / 2);
    }
    ctx.imageSmoothingEnabled = true;
    if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, 0, 0);
    ctx.restore();
  };

  /*
   * 按导出参数创建全分辨率离屏画布并导出 Blob。
   * JPG 不支持透明：先铺白色底（实现决策 5）；PNG 保持透明无损。
   * image 为 loadImage() 的返回值。
   *
   * 关键换算：导出画布的 1px = 1 个旋转后原图像素，而 params 里的
   * scale/offsetX/offsetY 是预览的显示像素系（scale = 显示像素/图像像素）。
   * 绘制前必须把变换换算到图像像素系：缩放置 1、位移除以 scale，
   * 否则大图会按预览比例缩小画进画布、留出大片空白。
   */
  utils.exportImage = function (image, params, mimeType, quality) {
    return new Promise(function (resolve, reject) {
      var canvas = document.createElement('canvas');
      canvas.width = params.width;
      canvas.height = params.height;
      var ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('无法创建导出画布'));
        return;
      }
      if (mimeType === 'image/jpeg') {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, params.width, params.height);
      }
      utils.drawSource(ctx, image.source, {
        scale: 1,
        offsetX: params.offsetX / params.scale,
        offsetY: params.offsetY / params.scale,
        rotation: params.rotation,
        imgW: params.imgW,
        imgH: params.imgH
      });
      canvas.toBlob(
        function (blob) {
          if (blob) resolve(blob);
          else reject(new Error('浏览器导出失败，图片可能超出画布限制'));
        },
        mimeType,
        quality
      );
    });
  };

  /*
   * 浏览器单画布像素上限（实现决策 3）。
   * 移动端（尤其 iOS Safari）约 1677 万像素；桌面 Chrome/Firefox 为
   * 16384 边长、约 2.68 亿像素。超限会导致导出静默失败，导出前必须检查。
   */
  utils.canvasLimit = function () {
    var isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
    if (isMobile) {
      return { area: 16 * 1024 * 1024, side: 8192 };
    }
    return { area: 268 * 1024 * 1024, side: 16384 };
  };

  utils.isOverCanvasLimit = function (width, height) {
    var limit = utils.canvasLimit();
    return width * height > limit.area || width > limit.side || height > limit.side;
  };

  utils.downloadBlob = function (blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () {
      URL.revokeObjectURL(url);
    }, 5000);
  };

  /*
   * 解析自定义比例输入（实现决策 6）："数字:数字"，允许小数和全角冒号。
   * 非法返回 null；0、负数、缺冒号、非数字一律拒绝。
   */
  utils.parseRatioInput = function (text) {
    var m = /^\s*(\d+(?:\.\d+)?)\s*[:：]\s*(\d+(?:\.\d+)?)\s*$/.exec(String(text));
    if (!m) return null;
    var w = parseFloat(m[1]);
    var h = parseFloat(m[2]);
    if (!isFinite(w) || !isFinite(h) || w <= 0 || h <= 0) return null;
    return { w: w, h: h };
  };

  function gcd(a, b) {
    while (b) {
      var t = a % b;
      a = b;
      b = t;
    }
    return a;
  }

  // 化简为最简整数比：6:9 → 2:3；小数按放大 100 倍取整后化简（2.35:1 → 47:20）
  utils.simplifyRatio = function (w, h) {
    var wi = Math.round(w * 100);
    var hi = Math.round(h * 100);
    if (wi <= 0 || hi <= 0) return { w: w, h: h };
    var g = gcd(wi, hi);
    wi /= g;
    hi /= g;
    // 避免极端小数产生巨大的数字
    if (wi > 10000 || hi > 10000) return { w: Math.round(w * 100) / 100, h: Math.round(h * 100) / 100 };
    return { w: wi, h: hi };
  };

  /*
   * 检测图片宽高对应的最简比例（实现决策 10）：
   * 1. 先与常见预设（1:1、4:3、3:4、3:2、2:3、16:9、9:16）比对，
   *    相对误差 = |w/h − pw/ph| / (pw/ph)，取误差最小的预设；
   *    若最小相对误差 < 1%（0.01），归入该预设（如 4030×3026 归为 4:3），
   *    返回 { w: 预设w, h: 预设h, snapped: true }。
   * 2. 真实偏离超过 1% 的（如全景 2.35:1）按 simplifyRatio 精确化简，
   *    返回 { w, h, snapped: false }（simplifyRatio 自带 >10000 保护）。
   * 入参守卫：w/h 非有限或 <=0 时返回 null。
   */
  utils.detectRatio = function (w, h) {
    if (!isFinite(w) || !isFinite(h) || w <= 0 || h <= 0) return null;
    // 实现“丑比例归拢规则”的常见预设列表（实现决策 10）
    var presets = [[1, 1], [4, 3], [3, 4], [3, 2], [2, 3], [16, 9], [9, 16]];
    var actual = w / h;
    var best = null;
    var bestErr = Infinity;
    for (var i = 0; i < presets.length; i++) {
      var target = presets[i][0] / presets[i][1];
      var err = Math.abs(actual - target) / target;
      if (err < bestErr) {
        bestErr = err;
        best = presets[i];
      }
    }
    // 相对误差小于 1% 即归入该预设
    if (bestErr < 0.01) {
      return { w: best[0], h: best[1], snapped: true };
    }
    // 偏离超过 1%：按精确化简比例照实返回
    var simp = utils.simplifyRatio(w, h);
    return { w: simp.w, h: simp.h, snapped: false };
  };

  global.RatioCraftUtils = utils;
})(window);
