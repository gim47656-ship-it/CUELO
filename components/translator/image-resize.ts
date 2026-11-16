/** 사진을 긴 변 1600px 이하 JPEG로 줄여 데이터 주소로 돌려준다. 폰 사진(수 MB)을 서버 한도 안으로 맞춘다. */
export const IMAGE_MAX_EDGE = 1600;
export const IMAGE_JPEG_QUALITY = 0.85;

/** 긴 변이 `maxEdge`를 넘을 때만 비율을 지켜 줄인 크기. */
export function fitWithin(width: number, height: number, maxEdge = IMAGE_MAX_EDGE): { width: number; height: number } {
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

export async function resizeImageToDataUrl(file: Blob): Promise<string> {
  // 폰이 EXIF로 돌려 둔 사진을 보이는 방향 그대로 읽는다.
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  try {
    const { width, height } = fitWithin(bitmap.width, bitmap.height);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("canvas unavailable");
    // JPEG에는 투명이 없으므로 투명 PNG가 검게 나오지 않게 흰 바탕을 깐다.
    context.fillStyle = "#fff";
    context.fillRect(0, 0, width, height);
    context.drawImage(bitmap, 0, 0, width, height);
    return canvas.toDataURL("image/jpeg", IMAGE_JPEG_QUALITY);
  } finally {
    bitmap.close();
  }
}
