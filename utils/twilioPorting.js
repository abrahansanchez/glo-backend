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
  const { accountSid } = getTwilioCredentials();
  const normalizedDocuments = Array.isArray(payload.documents)
    ? payload.documents
        .filter((d) => d && (d.docType || d.type) && (d.url || d.documentUrl || d.sid || d.twilioDocSid))
        .map((d) => {
          const type = String(d.docType || d.type).toLowerCase();
          const sid = d.twilioDocSid || d.sid || d.documentSid || undefined;
          const url = d.url || d.documentUrl || undefined;
          return {
            type,
            sid,
            documentSid: sid,
            url,
            Type: type.toUpperCase(),
            Sid: sid,
            DocumentSid: sid,
            Url: url,
          };
        })
    : undefined;

  const body = {
    accountSid,
    phoneNumber: payload.phoneNumber,
    country: payload.country || "US",
    businessName: payload.businessName,
    authorizedName: payload.authorizedName,
    serviceAddress: payload.serviceAddress,
    carrierName: payload.carrierName,
    accountNumber: payload.accountNumber,
    pin: payload.pin || undefined,
    requestedFocDate: payload.requestedFocDate || undefined,
    statusCallbackUrl: process.env.TWILIO_PORTING_STATUS_WEBHOOK_URL || undefined,
    losingCarrierInformation: payload.losingCarrierInformation || undefined,
    documents: normalizedDocuments,
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
    LosingCarrierInformation: payload.losingCarrierInformation || undefined,
    Documents: normalizedDocuments,
  };
  console.log("[TWILIO_PORTING_REQUEST]", {
    keys: Object.keys(body),
    hasAccountSid: Boolean(body.accountSid),
    hasLosingCarrierInformation: Boolean(body.losingCarrierInformation),
    hasServiceAddress: Boolean(body.serviceAddress),
    documentsCount: Array.isArray(normalizedDocuments) ? normalizedDocuments.length : 0,
  });
  try {
    const { data } = await client.post(`${portingBase()}/PortIn`, body);
    const sid = data?.sid || data?.Sid || data?.id || null;
    const statusRaw = data?.status || data?.Status || "submitted";
    const status = normalizeTwilioPortStatus(statusRaw);
    return { sid, status, statusRaw, raw: data };
  } catch (err) {
    console.error("[TWILIO_PORTING_RESPONSE_ERROR]", {
      status: err?.response?.status || err?.status,
      data: err?.response?.data || err?.data || null,
      message: err?.message || "Unknown Twilio porting error",
    });
    throw err;
  }
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
  if (portSid) {
    form.append("PortInSid", String(portSid));
  }
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

export const uploadPortDocByUrl = async ({ portSid, docType, url }) => {
  const response = await fetch(url);
  if (!response.ok) {
    const err = new Error("Failed to download document URL for Twilio upload");
    err.code = "PORT_DOC_DOWNLOAD_FAILED";
    throw err;
  }
  const contentType = response.headers.get("content-type") || "application/octet-stream";
  const arrayBuffer = await response.arrayBuffer();
  const fileBuffer = Buffer.from(arrayBuffer);
  const safeName = `${String(docType).toLowerCase()}-${Date.now()}`;
  return uploadPortDoc({
    portSid,
    docType,
    fileBuffer,
    filename: safeName,
    contentType,
  });
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
