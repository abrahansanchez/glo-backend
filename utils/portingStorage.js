import crypto from "crypto";

const parseCloudinaryUrl = (url) => {
  const parsed = new URL(url);
  if (parsed.protocol !== "cloudinary:") return null;
  return {
    apiKey: decodeURIComponent(parsed.username || ""),
    apiSecret: decodeURIComponent(parsed.password || ""),
    cloudName: decodeURIComponent(parsed.hostname || ""),
  };
};

const uploadToCloudinary = async ({ fileBuffer, filename, contentType }) => {
  const cloudinaryUrl = String(process.env.CLOUDINARY_URL || "").trim();
  const cfg = parseCloudinaryUrl(cloudinaryUrl);
  if (!cfg?.apiKey || !cfg?.apiSecret || !cfg?.cloudName) {
    const err = new Error("Cloudinary config missing");
    err.code = "PORTING_STORAGE_CONFIG_MISSING";
    throw err;
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const folder = String(process.env.CLOUDINARY_PORTING_FOLDER || "glo/porting");
  const signInput = `folder=${folder}&timestamp=${timestamp}${cfg.apiSecret}`;
  const signature = crypto.createHash("sha1").update(signInput).digest("hex");

  const form = new FormData();
  form.append("file", new Blob([fileBuffer], { type: contentType || "application/octet-stream" }), filename);
  form.append("api_key", cfg.apiKey);
  form.append("timestamp", String(timestamp));
  form.append("folder", folder);
  form.append("signature", signature);
  form.append("resource_type", "raw");

  const endpoint = `https://api.cloudinary.com/v1_1/${cfg.cloudName}/raw/upload`;
  const response = await fetch(endpoint, {
    method: "POST",
    body: form,
  });
  const data = await response.json();
  if (!response.ok) {
    const err = new Error(data?.error?.message || "Cloudinary upload failed");
    err.code = "PORTING_STORAGE_UPLOAD_FAILED";
    throw err;
  }
  return data?.secure_url || data?.url || null;
};

export const uploadPortingDocToStorage = async ({ fileBuffer, filename, contentType }) => {
  const provider = String(process.env.PORTING_DOCS_STORAGE || "cloudinary").trim().toLowerCase();

  if (provider === "cloudinary") {
    const storageUrl = await uploadToCloudinary({ fileBuffer, filename, contentType });
    return { provider, storageUrl };
  }

  if (provider === "s3") {
    const err = new Error("S3 provider not yet wired in this build");
    err.code = "PORTING_STORAGE_PROVIDER_UNSUPPORTED";
    throw err;
  }

  const err = new Error("Unsupported PORTING_DOCS_STORAGE provider");
  err.code = "PORTING_STORAGE_PROVIDER_UNSUPPORTED";
  throw err;
};
