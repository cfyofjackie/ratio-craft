/*
 * crop-engine.js — 裁切核心状态机（纯逻辑，不依赖任何 DOM / 浏览器 API）
 *
 * 坐标系约定：
 * - "旋转后图片"：原图按 rotation 顺时针旋转 0/90/180/270° 后的图片像素空间。
 * - scale：1 个旋转后图片像素 对应多少个 裁切框显示像素（CSS px）。
 * - offsetX/offsetY：图片左上角相对裁切框左上角的位移（显示像素），恒 ≤ 0。
 * - 裁切框固定不动，图片在框内拖动 / 缩放，且必须始终完全覆盖裁切框。
 *
 * 导出参数按原图像素换算：输出边长 = 裁切框显示尺寸 / scale，
 * 因此预览放大越多，输出分辨率越低；最小缩放（cover）时保留最多原始像素。
 *
 * 迁移到小程序时本文件可原样复用。
 */
(function (global) {
  'use strict';

  // 相对最小缩放（cover）允许的最大放大倍数
  var MAX_ZOOM_FACTOR = 16;

  function CropEngine() {
    this.imgW = 0;
    this.imgH = 0;
    this.rotation = 0; // 0 / 90 / 180 / 270，顺时针
    this.ratioW = 1;
    this.ratioH = 1;
    this.frameW = 0; // 裁切框显示尺寸（CSS px）
    this.frameH = 0;
    this.scale = 1;
    this.offsetX = 0;
    this.offsetY = 0;
  }

  CropEngine.prototype.hasImage = function () {
    return this.imgW > 0 && this.imgH > 0;
  };

  CropEngine.prototype.setImage = function (width, height) {
    this.imgW = width;
    this.imgH = height;
    this.rotation = 0;
    this.resetView();
  };

  // 切换比例只更新比例本身；视图重置由调用方在布局完成后调用 resetView()
  // （见需求文档"实现决策 1"：切换比例后回到默认铺满状态）
  CropEngine.prototype.setRatio = function (w, h) {
    this.ratioW = w;
    this.ratioH = h;
  };

  // 由 UI 层在预览区尺寸 / 比例变化时调用
  // （见"实现决策 12"：预览尺寸变化时保持构图——构图只跟用户的拖动 / 缩放有关，
  // 跟窗口大小无关。窗口 resize、侧边栏出现等导致的框尺寸变化不应挪动用户选好的画面）：
  // - 保留相对缩放倍数（相对 cover 的 rel）；
  // - 保留"裁切框中心对应的图像内容点"，重算布局后把它重新对准新框中心；
  //   两者共同保证新框内画面是旧画面的等比缩放版，视觉上构图纹丝不动；
  // - 边界钳制（图片必须盖满裁切框）仍然生效，钳制时按"尽量少动"原则贴近原位置；
  // - 输出分辨率 = 框尺寸 ÷ scale，两者同比例变化，商不变，导出不受预览尺寸影响。
  // 注：比例切换导致 frame 形状变化时也走这里，但调用方（app.js）随后会显式
  // resetView()，故无需区分调用来源，统一按"保持构图"处理。
  CropEngine.prototype.setFrameSize = function (w, h) {
    var hasImg = this.hasImage();
    var valid = w > 0 && h > 0;
    var cxImg = 0;
    var cyImg = 0;
    var rel = 0;
    if (hasImg && valid) {
      // 更新 frame 前，记录当前裁切框中心对应的图像内容点（旋转后图像像素坐标）
      cxImg = (this.frameW / 2 - this.offsetX) / this.scale;
      cyImg = (this.frameH / 2 - this.offsetY) / this.scale;
      // 相对缩放倍数（分母是按旧 frame 算出的 cover 最小缩放）
      rel = this.scale / this.minScale();
    }
    this.frameW = w;
    this.frameH = h;
    if (hasImg && valid) {
      if (isFinite(rel) && rel > 0) {
        // 按新 frame 的 cover 恢复相对倍数，再把记录的内容点对准新框中心
        this.scale = this.clampScale(newMinScale(this) * rel);
        this.offsetX = this.frameW / 2 - cxImg * this.scale;
        this.offsetY = this.frameH / 2 - cyImg * this.scale;
      } else {
        // rel 异常（非有限 / ≤ 0）说明状态不可信，回退到默认铺满
        this.resetView();
      }
    }
    this.clampOffsets();
  };

  CropEngine.prototype.rotatedSize = function () {
    if (this.rotation % 180 === 0) {
      return { w: this.imgW, h: this.imgH };
    }
    return { w: this.imgH, h: this.imgW };
  };

  CropEngine.prototype.minScale = function () {
    if (!this.hasImage() || this.frameW <= 0 || this.frameH <= 0) return 1;
    var r = this.rotatedSize();
    return Math.max(this.frameW / r.w, this.frameH / r.h);
  };

  CropEngine.prototype.clampScale = function (s) {
    var min = this.minScale();
    return Math.min(min * MAX_ZOOM_FACTOR, Math.max(min, s));
  };

  // 默认状态：刚好铺满裁切框（cover）、居中
  CropEngine.prototype.resetView = function () {
    this.scale = this.minScale();
    this.offsetX = (this.frameW - this.scale * this.rotatedSize().w) / 2;
    this.offsetY = (this.frameH - this.scale * this.rotatedSize().h) / 2;
    this.clampOffsets();
  };

  // 顺时针旋转 90°（见"实现决策 2"：只转图片，裁切框与输出尺寸不变；
  // 旋转后重置视图，保持行为可预期）
  CropEngine.prototype.rotate90 = function () {
    this.rotation = (this.rotation + 90) % 360;
    this.resetView();
  };

  // 拖动：dx/dy 为显示像素位移
  CropEngine.prototype.pan = function (dx, dy) {
    this.offsetX += dx;
    this.offsetY += dy;
    this.clampOffsets();
  };

  // 以 (cx, cy) 为锚点缩放 factor 倍（锚点为相对裁切框左上角的显示坐标）
  CropEngine.prototype.zoomAt = function (factor, cx, cy) {
    var s0 = this.scale;
    var s = this.clampScale(s0 * factor);
    if (s === s0) return;
    var k = s / s0;
    this.offsetX = cx - (cx - this.offsetX) * k;
    this.offsetY = cy - (cy - this.offsetY) * k;
    this.scale = s;
    this.clampOffsets();
  };

  // 绝对倍数缩放（见"实现决策 7"）：factor 相对初始铺满状态（cover，即 1×），
  // 而非当前缩放——输入 3 就是 cover 的 3 倍，与当前处于几倍无关。
  // 锚点 (cx, cy)（裁切框显示坐标）下的图像点保持不动，其余逻辑与 zoomAt 相同；
  // 结果仍受 clampScale 钳制（下限 cover，上限 16 倍 cover）。
  // 无图时 minScale() 返回 1 没有意义，故加 hasImage 守卫直接忽略。
  CropEngine.prototype.setAbsoluteZoom = function (factor, cx, cy) {
    if (!this.hasImage()) return;
    var s0 = this.scale;
    var s = this.clampScale(this.minScale() * factor);
    if (s === s0) return;
    var k = s / s0;
    this.offsetX = cx - (cx - this.offsetX) * k;
    this.offsetY = cy - (cy - this.offsetY) * k;
    this.scale = s;
    this.clampOffsets();
  };

  // 双指缩放：把捏合起点锚点下的图像点跟随到当前两指中点
  CropEngine.prototype.pinchTo = function (sRaw, start, cur, s0, ox0, oy0) {
    if (!(s0 > 0)) return;
    var s = this.clampScale(sRaw);
    this.scale = s;
    this.offsetX = cur.x - (s / s0) * (start.x - ox0);
    this.offsetY = cur.y - (s / s0) * (start.y - oy0);
    this.clampOffsets();
  };

  // 约束：图片必须始终覆盖整个裁切框
  CropEngine.prototype.clampOffsets = function () {
    if (!this.hasImage()) return;
    var r = this.rotatedSize();
    var minX = this.frameW - this.scale * r.w;
    var minY = this.frameH - this.scale * r.h;
    this.offsetX = Math.min(0, Math.max(minX, this.offsetX));
    this.offsetY = Math.min(0, Math.max(minY, this.offsetY));
  };

  // 当前裁切区域对应的输出分辨率（像素）
  CropEngine.prototype.outputSize = function () {
    return {
      w: Math.max(1, Math.round(this.frameW / this.scale)),
      h: Math.max(1, Math.round(this.frameH / this.scale))
    };
  };

  // 导出参数：按原图像素换算，供 image-utils 的 drawSource 使用。
  // width/height 是导出 Canvas 的像素尺寸；scale/offset/rotation 与预览一致，
  // 但绘制到全分辨率画布上，因此绝不截取低分辨率预览。
  CropEngine.prototype.getExportParams = function () {
    var out = this.outputSize();
    return {
      width: out.w,
      height: out.h,
      scale: this.scale,
      offsetX: this.offsetX,
      offsetY: this.offsetY,
      rotation: this.rotation,
      imgW: this.imgW,
      imgH: this.imgH
    };
  };

  function newMinScale(engine) {
    if (!engine.hasImage() || engine.frameW <= 0 || engine.frameH <= 0) return 1;
    var r = engine.rotatedSize();
    return Math.max(engine.frameW / r.w, engine.frameH / r.h);
  }

  global.CropEngine = CropEngine;
})(window);
