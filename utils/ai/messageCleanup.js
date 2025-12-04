export function cleanUserMessage(message) {
  if (!message) return "";
  return message.replace(/\n/g, " ").trim();
}
