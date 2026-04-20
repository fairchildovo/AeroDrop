export interface SessionActivityTracker {
  begin: () => number;
  current: () => number;
  isCurrent: (token: number) => boolean;
}

export const createSessionActivityTracker = (initialToken = 0): SessionActivityTracker => {
  let currentToken = initialToken;

  return {
    begin: () => {
      currentToken += 1;
      return currentToken;
    },
    current: () => currentToken,
    isCurrent: (token) => token === currentToken,
  };
};
