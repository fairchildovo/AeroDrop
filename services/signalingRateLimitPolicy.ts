export type SignalingRateLimitReason =
  | 'client-rate-limited'
  | 'target-rate-limited';

export type SignalingRateLimitDecision =
  | {
      allowed: true;
      tracked: boolean;
    }
  | {
      allowed: false;
      tracked: true;
      reason: SignalingRateLimitReason;
      retryAfterMs: number;
    };

type RateBucket = {
  blockedUntil: number;
  count: number;
  windowStartedAt: number;
};

type SignalingRateLimiterOptions = {
  blockMs: number;
  maxAttemptsPerClientWindow: number;
  maxAttemptsPerTargetWindow: number;
  windowMs: number;
};

type RecordOfferAttemptInput = {
  clientKey: string;
  now: number;
  targetPeerId: string;
};

const DEFAULT_OPTIONS: SignalingRateLimiterOptions = {
  blockMs: 10 * 60 * 1000,
  maxAttemptsPerClientWindow: 10,
  maxAttemptsPerTargetWindow: 20,
  windowMs: 60 * 1000,
};

export const isFourDigitSharePeerId = (peerId: string): boolean =>
  /^aerodrop-\d{4}$/.test(peerId);

const getBucket = (
  buckets: Map<string, RateBucket>,
  key: string,
  now: number,
  windowMs: number
): RateBucket => {
  const existing = buckets.get(key);
  if (!existing || now - existing.windowStartedAt >= windowMs) {
    const next = {
      blockedUntil: existing?.blockedUntil && existing.blockedUntil > now ? existing.blockedUntil : 0,
      count: 0,
      windowStartedAt: now,
    };
    buckets.set(key, next);
    return next;
  }

  return existing;
};

const recordBucket = (
  bucket: RateBucket,
  now: number,
  maxAttempts: number,
  blockMs: number
): { allowed: true } | { allowed: false; retryAfterMs: number } => {
  if (bucket.blockedUntil > now) {
    return {
      allowed: false,
      retryAfterMs: bucket.blockedUntil - now,
    };
  }

  bucket.count += 1;
  if (bucket.count <= maxAttempts) {
    return { allowed: true };
  }

  bucket.blockedUntil = now + blockMs;
  return {
    allowed: false,
    retryAfterMs: blockMs,
  };
};

export const createSignalingRateLimiter = (
  partialOptions: Partial<SignalingRateLimiterOptions> = {}
) => {
  const options = {
    ...DEFAULT_OPTIONS,
    ...partialOptions,
  };
  const clientBuckets = new Map<string, RateBucket>();
  const targetBuckets = new Map<string, RateBucket>();

  return {
    recordOfferAttempt(input: RecordOfferAttemptInput): SignalingRateLimitDecision {
      if (!isFourDigitSharePeerId(input.targetPeerId)) {
        return {
          allowed: true,
          tracked: false,
        };
      }

      const clientBucket = getBucket(clientBuckets, input.clientKey, input.now, options.windowMs);
      const clientDecision = recordBucket(
        clientBucket,
        input.now,
        options.maxAttemptsPerClientWindow,
        options.blockMs
      );
      if (!clientDecision.allowed) {
        return {
          allowed: false,
          tracked: true,
          reason: 'client-rate-limited',
          retryAfterMs: clientDecision.retryAfterMs,
        };
      }

      const targetBucket = getBucket(targetBuckets, input.targetPeerId, input.now, options.windowMs);
      const targetDecision = recordBucket(
        targetBucket,
        input.now,
        options.maxAttemptsPerTargetWindow,
        options.blockMs
      );
      if (!targetDecision.allowed) {
        return {
          allowed: false,
          tracked: true,
          reason: 'target-rate-limited',
          retryAfterMs: targetDecision.retryAfterMs,
        };
      }

      return {
        allowed: true,
        tracked: true,
      };
    },
  };
};
