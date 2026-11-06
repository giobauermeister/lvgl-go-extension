// iOS selects launch images by screen size, pixel ratio and orientation.
// Screen dimensions are CSS pixels; PNG dimensions are physical pixels.
const screens = [
  [320, 568, 2], [375, 667, 2], [414, 736, 3], [375, 812, 3],
  [414, 896, 2], [414, 896, 3], [390, 844, 3], [393, 852, 3],
  [402, 874, 3], [420, 912, 3], [428, 926, 3], [430, 932, 3], [440, 956, 3],
  [744, 1133, 2], [768, 1024, 2], [810, 1080, 2], [820, 1180, 2],
  [834, 1112, 2], [834, 1194, 2], [834, 1210, 2], [1024, 1366, 2], [1032, 1376, 2]
];

const startupImages = screens.flatMap(([screenWidth, screenHeight, ratio]) =>
  ['portrait', 'landscape'].map(orientation => {
    const width = (orientation === 'portrait' ? screenWidth : screenHeight) * ratio;
    const height = (orientation === 'portrait' ? screenHeight : screenWidth) * ratio;
    return {
      width, height, ratio, name: `startup-${width}x${height}.png`,
      media: `screen and (device-width: ${screenWidth}px) and (device-height: ${screenHeight}px) and (-webkit-device-pixel-ratio: ${ratio}) and (orientation: ${orientation})`
    };
  }));

module.exports = { startupImages };
