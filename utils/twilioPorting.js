import axios from "axios";

const DEFAULT_PORTING_BASE = "https://numbers.twilio.com/v1/Porting";
const DEFAULT_NUMBERS_UPLOAD_BASE = "https://numbers-upload.twilio.com/v1";

const getTwilioCredentials = () => {
  const accountSid = String(process.env.TWILIO_ACCOUNT_SID || "").trim();
  const authToken = String(process.env.TWILIO_AUTH_TOKEN || "").trim();
  if (!accountSid || !authToken) {
    const err = new Error("Missing Twilio credentials");
    err.code = "TWILIO_CONFIG_MISSING";
    throw err;
  }
  return { accountSid, authToken };
};

const twilioClient = () => {
  const { accountSid, authToken } = getTwilioCredentials();
  return axios.create({
    auth: { username: accountSid, password: authToken },
    timeout: 15000,
  });
};

const portingBase = () =>
  String(process.env.TWILIO_PORTING_API_BASE_URL || DEFAULT_PORTING_BASE).replace(/\/$/, "");

const numbersUploadBase = () =>
  String(process.env.TWILIO_NUMBERS_UPLOAD_BASE_URL || DEFAULT_NUMBERS_UPLOAD_BASE).replace(/\/$/, "");

export const normalizeTwilioPortStatus = (rawStatus) => {
  const raw = String(rawStatus || "draft").trim().toLowerCase();
  if (!raw) return "draft";
  if (["draft"].includes(raw)) return "draft";
  if (["submitted", "pending", "requested", "new", "created"].includes(raw)) return "submitted";
  if (["in_review", "review", "carrier_review", "pending_carrier", "pending_vendor"].includes(raw)) {
    return "carrier_review";
  }
  if (["approved", "foc_scheduled", "scheduled"].includes(raw)) return "approved";
  if (["completed", "ported", "fulfilled"].includes(raw)) return "completed";
  if (["rejected", "failed", "canceled", "cancelled", "error"].includes(raw)) return "rejected";
  return "submitted";
};

export const createPortOrder = async (payload) => {
  const client = twilioClient();
  const body = {
    PhoneNumber: payload.phoneNumber,
    Country: payload.country || "US",
    BusinessName: payload.businessName,
    AuthorizedName: payload.authorizedName,
    ServiceAddress: payload.serviceAddress,
    CarrierName: payload.carrierName,
    AccountNumber: payload.accountNumber,
    Pin: payload.pin || undefined,
    RequestedFocDate: payload.requestedFocDate || undefined,
    StatusCallbackUrl: process.env.TWILIO_PORTING_STATUS_WEBHOOK_URL || undefined,
  };

  const { data } = await client.post(`${portingBase()}/PortIn`, body);
  const sid = data?.sid || data?.Sid || data?.id || null;
  const statusRaw = data?.status || data?.Status || "submitted";
  const status = normalizeTwilioPortStatus(statusRaw);
  return { sid, status, statusRaw, raw: data };
};

export const uploadPortDoc = async ({
  portSid,
  docType,
  fileBuffer,
  filename,
  contentType,
}) => {
  const client = twilioClient();

  const form = new FormData();
  form.append("FriendlyName", `${docType}-${Date.now()}`);
  form.append("PortInSid", String(portSid));
  form.append("Type", String(docType).toUpperCase());
  form.append("File", new Blob([fileBuffer], { type: contentType || "application/octet-stream" }), filename);

  const { data } = await client.post(`${numbersUploadBase()}/Documents`, form, {
    headers: {},
  });

  return {
    sid: data?.sid || data?.Sid || data?.id || null,
    raw: data,
  };
};

export const fetchPortOrder = async (portSid) => {
  const client = twilioClient();
  const { data } = await client.get(`${portingBase()}/PortIn/${encodeURIComponent(portSid)}`);
  const statusRaw = data?.status || data?.Status || "submitted";
  return {
    sid: data?.sid || data?.Sid || data?.id || portSid,
    statusRaw,
    status: normalizeTwilioPortStatus(statusRaw),
    raw: data,
  };
};

export const listPortOrdersByPhone = async (phone) => {
  const client = twilioClient();
  const { data } = await client.get(`${portingBase()}/PortIn`, {
    params: { PhoneNumber: phone },
  });
  return data;
};
