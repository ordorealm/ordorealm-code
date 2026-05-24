/**
 * Async Iterable Queue
 *
 * A queue that implements the async iterable protocol.
 * Used for streaming SDK responses and events.
 *
 * @module electron/shared/async-queue
 */

/**
 * A queue that can be consumed as an async iterable.
 * Allows producers to enqueue items and consumers to iterate over them asynchronously.
 *
 * @example
 * ```typescript
 * const queue = new AsyncIterableQueue<string>()
 *
 * // Producer
 * queue.enqueue('item1')
 * queue.enqueue('item2')
 * queue.close()
 *
 * // Consumer
 * for await (const item of queue) {
 *   console.log(item) // 'item1', 'item2'
 * }
 * ```
 */
export class AsyncIterableQueue<T> {
  private queue: T[] = []
  private resolve: ((value: IteratorResult<T>) => void) | null = null
  private done = false

  /**
   * Enqueue an item to the queue.
   * If a consumer is waiting, the item is delivered directly.
   * Otherwise, the item is added to the queue for later consumption.
   *
   * @param item - The item to enqueue
   */
  enqueue(item: T): void {
    if (this.done) return

    if (this.resolve) {
      // Waiting consumer, deliver directly
      const r = this.resolve
      this.resolve = null
      r({ value: item, done: false })
    } else {
      // No waiting consumer, queue the item
      this.queue.push(item)
    }
  }

  /**
   * Close the queue.
   * After closing, no more items can be enqueued.
   * Any waiting consumer will receive done=true.
   */
  close(): void {
    this.done = true

    if (this.resolve) {
      const r = this.resolve
      this.resolve = null
      r({ value: undefined as any, done: true })
    }
  }

  /**
   * Check if the queue is closed
   */
  isClosed(): boolean {
    return this.done
  }

  /**
   * Get the current queue length (items waiting to be consumed)
   */
  get length(): number {
    return this.queue.length
  }

  /**
   * Implement the async iterable protocol.
   * Allows the queue to be used with `for await...of` syntax.
   */
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.queue.length > 0) {
          return Promise.resolve({ value: this.queue.shift()!, done: false })
        }

        if (this.done) {
          return Promise.resolve({ value: undefined as any, done: true })
        }

        // Wait for next item or close
        return new Promise((resolve) => {
          this.resolve = resolve
        })
      },
    }
  }
}
