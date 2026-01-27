/**
 * Transfer configuration constants
 * Extracted for easier tuning and maintenance
 */

// === Chunk and Buffer Sizes ===
export const TRANSFER_CONFIG = {
  // Chunk sizes for different network types
  CHUNK_SIZE_LAN: 256 * 1024,    // 256KB for LAN (reduce protocol overhead)
  CHUNK_SIZE_WAN: 64 * 1024,     // 64KB for WAN (conservative for stability)

  // Read buffer size for file IO
  READ_BUFFER_SIZE: 16 * 1024 * 1024,  // 16MB - fewer IO operations

  // Write buffer threshold for receiver
  WRITE_BUFFER_FLUSH_THRESHOLD: 16 * 1024 * 1024,  // 16MB
} as const;

// === Flow Control (Hysteresis) ===
export const FLOW_CONTROL = {
  // LAN: Higher watermarks to utilize high-speed network
  HIGH_WATER_MARK_LAN: 4 * 1024 * 1024,   // 4MB
  LOW_WATER_MARK_LAN: 1 * 1024 * 1024,    // 1MB

  // WAN: Conservative to avoid bufferbloat
  HIGH_WATER_MARK_WAN: 256 * 1024,        // 256KB
  LOW_WATER_MARK_WAN: 0,                   // 0KB
} as const;

// === Timeouts ===
export const TIMEOUTS = {
  CONNECTION_TIMEOUT: 15000,      // 15 seconds for WebRTC connection
  RETRY_DELAY: 2000,              // 2 seconds between retries
  MAX_RETRY_COUNT: 3,             // Maximum connection retries
  NOTIFICATION_DURATION: 4000,    // 4 seconds for toast notifications
  COPY_FEEDBACK_DURATION: 2000,   // 2 seconds for copy confirmation
} as const;

// === UI Update Intervals ===
export const UI_INTERVALS = {
  STATS_UPDATE: 800,              // 800ms for sender stats
  SPEED_UPDATE: 1000,             // 1 second for speed calculation
} as const;

// === Expiry Options (in milliseconds) ===
export const EXPIRY_DURATIONS = {
  '10m': 10 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '1d': 24 * 60 * 60 * 1000,
  'never': undefined,
} as const;

export type ExpiryOption = keyof typeof EXPIRY_DURATIONS;
