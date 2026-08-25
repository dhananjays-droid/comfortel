/** The aspect ratios gpt-image accepts. A photo is mapped to the nearest one. */
const ASPECTS = [
  { label: "1:1", value: 1 },
  { label: "3:2", value: 3 / 2 },
  { label: "2:3", value: 2 / 3 },
] as const;

export type AspectRatio = (typeof ASPECTS)[number]["label"];

export type ResizedImage = {
  /** base64 JPEG, no data: prefix */
  base64: string;
  width: number;
  height: number;
  aspectRatio: AspectRatio;
};

function nearestAspect(width: number, height: number): AspectRatio {
  const ratio = width / height;
  return ASPECTS.reduce((best, o) =>
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
  // Phone photos are often shot in low light; smoothing the downscale keeps the
  // room's texture readable for the model instead of aliasing it into noise.
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, width, height);

  const jpeg = canvas.toDataURL("image/jpeg", 0.85);
  return {
    base64: jpeg.split(",")[1] ?? "",
    width,
    height,
    aspectRatio: nearestAspect(width, height),
  };
}
