export const V1_MEDIA_PATH = "/ws/media";
export const V2_MEDIA_PATH = "/ws/media-v2";

export function isValidVoiceV2BusinessId(value) {
  return /^[a-f\d]{24}$/i.test(String(value || "").trim());
}

export function selectVoiceMediaPath({ resolvedBusinessId, enabledValue, approvedBusinessId } = {}) {
  const approved = String(approvedBusinessId || "").trim();
  return enabledValue === "true"
    && isValidVoiceV2BusinessId(approved)
    && String(resolvedBusinessId || "") === approved
    ? V2_MEDIA_PATH
    : V1_MEDIA_PATH;
}
