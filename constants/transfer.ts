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
// Hysteresis prevents oscillation: send until HIGH, pause until LOW, repeat
// The gap between HIGH and LOW determines burst size and smoothness
export const FLOW_CONTROL = {
  // LAN: Aggressive settings for high-speed local network
  // Gigabit LAN can easily handle 100+ MB/s, so large buffers are beneficial
  HIGH_WATER_MARK_LAN: 8 * 1024 * 1024,   // 8MB - allow large bursts
  LOW_WATER_MARK_LAN: 2 * 1024 * 1024,    // 2MB - resume before empty (75% drain)

  // WAN: Balanced for variable network conditions
  // Too aggressive causes bufferbloat; too conservative wastes bandwidth
  HIGH_WATER_MARK_WAN: 512 * 1024,        // 512KB - moderate buffer
  LOW_WATER_MARK_WAN: 128 * 1024,         // 128KB - resume at 25% (don't wait for empty!)
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
