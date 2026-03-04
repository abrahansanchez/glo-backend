import { v2 as cloudinary } from "cloudinary";

const uploadToCloudinary = ({ fileBuffer, contentType, docType }) =>
  new Promise((resolve, reject) => {
    const folder = String(process.env.CLOUDINARY_PORTING_FOLDER || "glo/porting");
    const resourceType = String(contentType || "").toLowerCase() === "application/pdf" ? "raw" : "image";
    const stream = cloudinary.uploader.upload_stream(
      { resource_type: resourceType, folder },
      (error, result) => {
        if (error) return reject(error);
        console.log(
          `[CLOUDINARY_UPLOAD_OK] docType=${String(docType || "unknown")} resourceType=${String(
            result?.resource_type || ""
          )} url=${String(result?.secure_url || "")}`
        );
        return resolve(result);
      }
    );
    stream.end(fileBuffer);
  });

export const uploadPortingDocToStorage = async ({ fileBuffer, filename, contentType, docType }) => {
  const provider = String(process.env.PORTING_DOCS_STORAGE || "cloudinary").trim().toLowerCase();

  if (provider === "cloudinary") {
    const result = await uploadToCloudinary({ fileBuffer, contentType, docType });
    const storageUrl = result?.secure_url || null;
    if (!storageUrl) {
      const err = new Error("Cloudinary upload failed");
      err.code = "PORTING_STORAGE_UPLOAD_FAILED";
      throw err;
    }
    return {
      provider,
      storageUrl,
      cloudinaryResourceType: result?.resource_type || null,
    };
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
