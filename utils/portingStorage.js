import { v2 as cloudinary } from "cloudinary";

const uploadToCloudinary = (fileBuffer) =>
  new Promise((resolve, reject) => {
    const folder = String(process.env.CLOUDINARY_PORTING_FOLDER || "glo/porting");
    const stream = cloudinary.uploader.upload_stream(
      { resource_type: "auto", folder },
      (error, result) => {
        if (error) {
          console.error("Cloudinary upload error:", error);
          const err = new Error("Cloudinary upload failed");
          err.code = "PORTING_STORAGE_UPLOAD_FAILED";
          return reject(err);
        }
        return resolve(result);
      }
    );
    stream.end(fileBuffer);
  });

export const uploadPortingDocToStorage = async ({ fileBuffer, filename, contentType }) => {
  const provider = String(process.env.PORTING_DOCS_STORAGE || "cloudinary").trim().toLowerCase();

  if (provider === "cloudinary") {
    const result = await uploadToCloudinary(fileBuffer);
    const storageUrl = result?.secure_url || result?.url || null;
    if (!storageUrl) {
      const err = new Error("Cloudinary upload failed");
      err.code = "PORTING_STORAGE_UPLOAD_FAILED";
      throw err;
    }
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
