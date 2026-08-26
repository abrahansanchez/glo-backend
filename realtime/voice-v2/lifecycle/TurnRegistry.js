export class TurnRegistry {
  #records = new Map();
  #tail = Promise.resolve();
  acquire({ turnId, transcript }, processor) {
    if (!turnId) throw new TypeError("missing_turn_id");
    const existing = this.#records.get(turnId);
    if (existing) return existing.promise;
    const record = { turnId, transcript, status: "queued", result: null, promise: null };
    record.promise = this.#tail.then(async () => {
      record.status = "processing";
      try { record.result = await processor(Object.freeze({ turnId, transcript })); record.status = "consumed"; return Object.freeze({ replayed: false, result: record.result }); }
      catch (error) { record.status = "failed"; throw error; }
    });
    this.#tail = record.promise.catch(() => undefined);
    this.#records.set(turnId, record);
    return record.promise;
  }
  get(turnId) { const item = this.#records.get(turnId); return item ? Object.freeze({ turnId: item.turnId, status: item.status, result: item.result }) : null; }
  async replay(turnId) { const item = this.#records.get(turnId); if (!item) return null; const completed = await item.promise; return Object.freeze({ replayed: true, result: completed.result }); }
}
