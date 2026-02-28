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
  const documentSids = Array.isArray(payload.documents)
    ? payload.documents
        .map((d) => String(d?.twilioDocSid || d?.sid || d?.documentSid || "").trim())
        .filter(Boolean)
    : undefined;

  const serviceAddress = payload.serviceAddress || {};
  const losingCarrierInformation = {
    customer_type: String(payload.customerType || "Business"),
    customer_name: String(payload.businessName || ""),
    account_number: String(payload.accountNumber || ""),
    account_telephone_number: String(payload.accountTelephoneNumber || payload.phoneNumber || ""),
    authorized_representative: String(payload.authorizedName || ""),
    authorized_representative_email: String(payload.authorizedRepresentativeEmail || ""),
    address: {
      street: String(serviceAddress.line1 || ""),
      city: String(serviceAddress.city || ""),
      state: String(serviceAddress.state || ""),
      zip: String(serviceAddress.postalCode || ""),
      country: String(serviceAddress.country || "US"),
    },
  };

  const body = {
    account_sid: accountSid,
    losing_carrier_information: losingCarrierInformation,
    phone_numbers: [
      {
        phone_number: String(payload.phoneNumber || ""),
        pin: payload.pin ? String(payload.pin) : null,
      },
    ],
    documents: documentSids,
  };
  console.log("[TWILIO_PORTING_REQUEST]", {
    keys: Object.keys(body),
    hasAccountSid: Boolean(body.account_sid),
    hasLosingCarrierInformation: Boolean(body.losing_carrier_information),
    documentsCount: Array.isArray(documentSids) ? documentSids.length : 0,
    allDocumentSidsAreRD: Array.isArray(documentSids)
      ? documentSids.every((sid) => String(sid).startsWith("RD"))
      : false,
  });
  try {
    const { data } = await client.post(`${portingBase()}/PortIn`, body, {
      headers: { "Content-Type": "application/json" },
    });
    const sid = data?.sid || data?.Sid || data?.id || null;
    const statusRaw = data?.status || data?.Status || "submitted";
    const status = normalizeTwilioPortStatus(statusRaw);
    return { sid, status, statusRaw, raw: data };
  } catch (err) {
    console.error("[TWILIO_PORTING_RESPONSE_ERROR]", {
      status: err?.response?.status || err?.status,
      data: err?.response?.data || err?.data || null,
      twilioMessage: err?.response?.data?.message || err?.response?.data?.error?.message || null,
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
  const twilioTypeByDocType = {
    loa: "LETTER_OF_AUTHORIZATION",
    bill: "UTILITY_BILL",
  };
  const mappedType = twilioTypeByDocType[String(docType || "").toLowerCase()] || String(docType).toUpperCase();

  const form = new FormData();
  form.append("FriendlyName", `${docType}-${Date.now()}`);
  if (portSid) {
    form.append("PortInSid", String(portSid));
  }
  form.append("Type", mappedType);
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
