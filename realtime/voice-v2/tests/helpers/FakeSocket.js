import { EventEmitter } from "node:events";

export class FakeSocket extends EventEmitter {
  constructor() { super(); this.readyState = 1; this.sent = []; this.closeCalls = []; }
  send(value) { if (this.readyState >= 2) throw new Error("socket_closed"); this.sent.push(JSON.parse(value)); }
  receive(value) { this.emit("message", JSON.stringify(value)); }
  open() { this.readyState = 1; this.emit("open"); }
  close(code, reason) { this.closeCalls.push({ code, reason }); this.readyState = 3; this.emit("close", { code, reason }); }
  fail(error) { this.emit("error", error); }
}
