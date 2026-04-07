export function getCdnImageUrl(
  r2Key: string,
  host: string,
  options?: {
    // Dimensions
    width?: number | "auto";
    height?: number;
    dpr?: number;

    // Resizing
    fit?: "scale-down" | "contain" | "cover" | "crop" | "pad";
    gravity?:
      | "auto"
      | "left"
      | "right"
      | "top"
      | "bottom"
      | "center"
      | "face"
      | "faces"
      | "entropy"
      | string; // string for coordinates like "0.5x0.5"
    zoom?: number; // 0-1 for face cropping

    // Quality & Format
    quality?: number | "low" | "medium-low" | "medium-high" | "high";
    format?: "auto" | "webp" | "avif" | "json" | "jpeg" | "png";
    compression?: "fast";

    // Transformations
    rotate?: 0 | 90 | 180 | 270;
    flip?: "h" | "v" | "both";
    blur?: number; // 1-250
    sharpen?: number; // 0-10

    // Color adjustments
    brightness?: number;
    contrast?: number;
    gamma?: number;
    saturation?: number;

    // Other
    anim?: boolean;
    background?: string; // CSS color
    metadata?: "keep" | "copyright" | "none";
    onerror?: "redirect";
    segment?: "foreground";
  }
) {
  // If r2Key is already a full URL, return it as-is
  if (r2Key.startsWith("http://") || r2Key.startsWith("https://")) {
    return r2Key;
  }

  const optionsStr = options
    ? Object.entries(options)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) =>
          key === "background"
            ? `${key}=${encodeURIComponent(value)}`
            : `${key}=${value}`
        )
        .join(",")
    : "";

  return `https://${host}/cdn-cgi/image/${optionsStr}/${r2Key}`;
}
