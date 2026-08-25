export type ResizedImage = {
  /** base64 JPEG, no data: prefix */
  base64: string;
  width: number;
  height: number;
  /** nearest supported kie aspect ratio */
  aspectRatio: "1:1" | "3:2" | "2:3";
};

function nearestAspect(width: number, height: number): "1:1" | "3:2" | "2:3" {
  const ratio = width / height;
  const options: Array<{ label: "1:1" | "3:2" | "2:3"; value: number }> = [
    { label: "1:1", value: 1 },
    { label: "3:2", value: 3 / 2 },
    { label: "2:3", value: 2 / 3 },
  ];
  return options.reduce((best, o) =>
    Math.abs(Math.log(o.value / ratio)) < Math.abs(Math.log(best.value / ratio)) ? o : best,
  ).label;
}

/** Resize an image file so its longest edge is 1024px, encode as JPEG q0.85. */
export async function resizeImage(file: File, maxEdge = 1024): Promise<ResizedImage> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error("read failed"));
    reader.readAsDataURL(file);
  });

  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("decode failed"));
    image.src = dataUrl;
  });

  const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
  const width = Math.round(img.width * scale);
  const height = Math.round(img.height * scale);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas unavailable");
  ctx.drawImage(img, 0, 0, width, height);

  const jpeg = canvas.toDataURL("image/jpeg", 0.85);
  return {
    base64: jpeg.split(",")[1] ?? "",
    width,
    height,
    aspectRatio: nearestAspect(width, height),
  };
}
