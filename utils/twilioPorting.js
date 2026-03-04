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
  const normalizedCustomerType = String(payload.customerType || "").trim().toLowerCase();
  const losingCarrierInformation = {
    customer_type: normalizedCustomerType === "business" ? "Business" : "Individual",
    customer_name: String(payload.businessName || ""),
    account_number: String(payload.accountNumber || ""),
    account_telephone_number: String(payload.accountTelephoneNumber || payload.phoneNumber || ""),
    authorized_representative: String(payload.authorizedName || ""),
    authorized_representative_email: String(payload.authorizedRepresentativeEmail || ""),
    address_sid: null,
    address: {
      street: String(serviceAddress.line1 || ""),
      street_2: String(serviceAddress.line2 || ""),
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
  const safe = JSON.parse(JSON.stringify(payload));
  if (safe?.account_sid) safe.account_sid = "***";
  const url = `${portingBase()}/PortIn`;
  console.log("[TWILIO_PORTIN_PAYLOAD]", safe);
  console.log("[TWILIO_PORTIN_URL]", url);
  console.log("[TWILIO_PORTIN_FINAL_JSON]", JSON.stringify(body, null, 2));
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
    const resp = await client.post(url, body, {
      headers: { "Content-Type": "application/json" },
    });
    console.log("[TWILIO_PORTIN_RESPONSE_STATUS]", resp.status);
    console.log("[TWILIO_PORTIN_RESPONSE_DATA]", JSON.stringify(resp.data, null, 2));

    const portInSid =
      resp.data?.sid ||
      resp.data?.port_in_sid ||
      resp.data?.portInSid ||
      resp.data?.port_in?.sid ||
      resp.data?.result?.sid ||
      null;

    if (!portInSid) {
      console.log("[TWILIO_PORTIN_RESPONSE_KEYS]", Object.keys(resp.data || {}));
      throw new Error("Twilio did not return a port-in SID (unknown response shape)");
    }

    const statusRaw = resp.data?.status || resp.data?.Status || "submitted";
    const status = normalizeTwilioPortStatus(statusRaw);
    return { sid: portInSid, status, statusRaw, raw: resp.data };
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
  url,
}) => {
  const client = twilioClient();
  const twilioTypeByDocType = {
    loa: "letter_of_authorization",
    bill: "utility_bill",
  };
  const normalizedDocType = String(docType || "").toLowerCase();
  const mappedType = twilioTypeByDocType[normalizedDocType];
  if (!mappedType) {
    const err = new Error(`Unsupported document type for Twilio upload: ${normalizedDocType}`);
    err.code = "PORT_DOC_TYPE_UNSUPPORTED";
    throw err;
  }

  const form = new FormData();
  form.append("friendly_name", "Porting utility bill");
  if (portSid) {
    form.append("PortInSid", String(portSid));
  }
  form.append("document_type", mappedType);
  console.log("[TWILIO_DOC_UPLOAD_FORM]", { type: mappedType });
  form.append("File", new Blob([fileBuffer], { type: contentType || "application/octet-stream" }), filename);

  console.log(
    `[TWILIO_DOC_UPLOAD] docType=${String(docType || "")} mappedType=${String(mappedType || "")} url=${String(
      url || ""
    )}`
  );
  const { data } = await client.post(`${numbersUploadBase()}/Documents`, form, {
    headers: {},
  });

  return {
    sid: data?.sid || data?.Sid || data?.id || null,
    raw: data,
  };
};

export const uploadPortDocByUrl = async ({ portSid, docType, url }) => {
  const normalizedDocType = String(docType || "").toLowerCase();
  if (!["loa", "bill"].includes(normalizedDocType)) {
    const err = new Error(`Unsupported document type for Twilio upload: ${normalizedDocType}`);
    err.code = "PORT_DOC_TYPE_UNSUPPORTED";
    throw err;
  }

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
    docType: normalizedDocType,
    fileBuffer,
    filename: safeName,
    contentType,
    url,
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
