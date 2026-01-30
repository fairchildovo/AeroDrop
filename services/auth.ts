import { User } from '../types';

const STORAGE_KEY_USER = 'aerodrop_user';
const STORAGE_KEY_USERS_DB = 'aerodrop_users_db';

export const getCurrentUser = (): User | null => {
  const stored = localStorage.getItem(STORAGE_KEY_USER);
  return stored ? JSON.parse(stored) : null;
};

export const loginUser = async (email: string, password: string): Promise<User> => {
  await new Promise(resolve => setTimeout(resolve, 800));

  const db = JSON.parse(localStorage.getItem(STORAGE_KEY_USERS_DB) || '[]');
  const user = db.find((u: any) => u.email === email && u.password === password);

  if (user) {
    const sessionUser = { id: user.id, email: user.email, name: user.email.split('@')[0] };
    localStorage.setItem(STORAGE_KEY_USER, JSON.stringify(sessionUser));
    return sessionUser;
  }
  throw new Error("Invalid credentials");
};

export const registerUser = async (email: string, password: string): Promise<User> => {
  await new Promise(resolve => setTimeout(resolve, 800));

  const db = JSON.parse(localStorage.getItem(STORAGE_KEY_USERS_DB) || '[]');
  if (db.find((u: any) => u.email === email)) {
    throw new Error("User already exists");
  }

  const newUser = { id: Date.now().toString(), email, password };
  db.push(newUser);
  localStorage.setItem(STORAGE_KEY_USERS_DB, JSON.stringify(db));

  const sessionUser = { id: newUser.id, email: newUser.email, name: newUser.email.split('@')[0] };
  localStorage.setItem(STORAGE_KEY_USER, JSON.stringify(sessionUser));
  return sessionUser;
};

export const logoutUser = () => {
  localStorage.removeItem(STORAGE_KEY_USER);
};
