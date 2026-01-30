


export const TRANSFER_CONFIG = {
  
  CHUNK_SIZE_LAN: 256 * 1024,    
  CHUNK_SIZE_WAN: 64 * 1024,     

  
  READ_BUFFER_SIZE: 16 * 1024 * 1024,  

  
  WRITE_BUFFER_FLUSH_THRESHOLD: 16 * 1024 * 1024,  
} as const;




export const FLOW_CONTROL = {
  
  
  HIGH_WATER_MARK_LAN: 8 * 1024 * 1024,   
  LOW_WATER_MARK_LAN: 2 * 1024 * 1024,    

  
  
  HIGH_WATER_MARK_WAN: 512 * 1024,        
  LOW_WATER_MARK_WAN: 128 * 1024,         
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
