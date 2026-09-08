/** Indexed min-heap: one node per owner, including after arbitrarily many renewals. */
export class RelayExpiryIndex {
  readonly #heap: { key: string; at: number }[] = [];
  readonly #positions = new Map<string, number>();

  get size(): number { return this.#heap.length; }

  set(key: string, at: number): void {
    if (!Number.isFinite(at)) throw new TypeError("invalid expiry");
    const existing = this.#positions.get(key);
    if (existing !== undefined) {
      this.#heap[existing]!.at = at;
      this.#down(this.#up(existing));
      return;
    }
    const index = this.#heap.length;
    this.#heap.push({ key, at });
    this.#positions.set(key, index);
    this.#up(index);
  }

  delete(key: string): boolean {
    const index = this.#positions.get(key);
    if (index === undefined) return false;
    this.#positions.delete(key);
    const last = this.#heap.pop()!;
    if (index < this.#heap.length) {
      this.#heap[index] = last;
      this.#positions.set(last.key, index);
      this.#down(this.#up(index));
    }
    return true;
  }

  takeDue(now: number): string | undefined {
    const first = this.#heap[0];
    if (!first || first.at > now) return undefined;
    this.delete(first.key);
    return first.key;
  }

  #swap(a: number, b: number): void {
    [this.#heap[a], this.#heap[b]] = [this.#heap[b]!, this.#heap[a]!];
    this.#positions.set(this.#heap[a]!.key, a);
    this.#positions.set(this.#heap[b]!.key, b);
  }

  #up(index: number): number {
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (this.#heap[parent]!.at <= this.#heap[index]!.at) break;
      this.#swap(index, parent);
      index = parent;
    }
    return index;
  }

  #down(index: number): void {
    for (;;) {
      const left = index * 2 + 1, right = left + 1;
      let smallest = index;
      if (left < this.#heap.length && this.#heap[left]!.at < this.#heap[smallest]!.at) smallest = left;
      if (right < this.#heap.length && this.#heap[right]!.at < this.#heap[smallest]!.at) smallest = right;
      if (smallest === index) return;
      this.#swap(index, smallest);
      index = smallest;
    }
  }
}
