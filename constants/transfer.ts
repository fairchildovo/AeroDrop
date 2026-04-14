


export const TRANSFER_CONFIG = {
  
  CHUNK_SIZE_LAN: 256 * 1024,    
  CHUNK_SIZE_WAN: 256 * 1024,    
  CHUNK_SIZE_RELAY: 128 * 1024,  

  
  READ_BUFFER_SIZE: 32 * 1024 * 1024,  

  
  WRITE_BUFFER_FLUSH_THRESHOLD: 32 * 1024 * 1024,  
} as const;




export const FLOW_CONTROL = {
  
  
  HIGH_WATER_MARK_LAN: 16 * 1024 * 1024,  
  LOW_WATER_MARK_LAN: 4 * 1024 * 1024,    

  
  
  // WAN 里 RTT 更高，适当提高在途缓冲可以显著提升吞吐
  HIGH_WATER_MARK_WAN: 8 * 1024 * 1024,   
  LOW_WATER_MARK_WAN: 2 * 1024 * 1024,    
  // Relay 链路 RTT 更高，维持更深的发送管线可避免 TURN 中继被频繁“饿死”。
  HIGH_WATER_MARK_RELAY: 8 * 1024 * 1024,
  LOW_WATER_MARK_RELAY: 2 * 1024 * 1024,
} as const;


export const TIMEOUTS = {
  CONNECTION_TIMEOUT: 15000,      
  RETRY_DELAY: 2000,              
  MAX_RETRY_COUNT: 3,             
  NOTIFICATION_DURATION: 4000,    
  COPY_FEEDBACK_DURATION: 2000,   
} as const;


export const UI_INTERVALS = {
  STATS_UPDATE: 800,              
  SPEED_UPDATE: 1000,             
} as const;


export const EXPIRY_DURATIONS = {
  '10m': 10 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '1d': 24 * 60 * 60 * 1000,
  'never': undefined,
} as const;

export type ExpiryOption = keyof typeof EXPIRY_DURATIONS;
