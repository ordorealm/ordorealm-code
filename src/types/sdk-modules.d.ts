/**
 * Type declarations for dynamically loaded SDK modules
 * These modules are optional dependencies loaded at runtime
 */

declare module '@anthropic-ai/claude-agent-sdk' {
  export function query(options: {
    prompt: AsyncIterable<any>
    options: Record<string, any>
  }): {
    close(): void
    interrupt(): Promise<void>
    supportedCommands(): Promise<any[]>
    mcpServerStatus(): Promise<any[]>
    setMcpServers(servers: Record<string, any>): Promise<any>
    toggleMcpServer(name: string, enabled: boolean): Promise<void>
    reconnectMcpServer(name: string): Promise<void>
    streamInput(stream: AsyncIterable<any>): Promise<void>
    [Symbol.asyncIterator](): AsyncIterator<any>
  }
}

declare module '@opencode-ai/sdk' {
  export interface OpenCodeClient {
    session: {
      create: (options: { project: string }) => Promise<{ id: string }>
      prompt: (sessionId: string, options: { prompt: string }) => Promise<void>
    }
    event: {
      subscribe: (
        sessionId: string,
        callback: (event: any) => void,
        options?: { signal?: AbortSignal }
      ) => Promise<void>
    }
  }

  export function createOpencodeClient(options: { baseUrl: string }): OpenCodeClient
}
