/** DI tokens for infrastructure clients (kept separate to avoid import cycles). */
export const REDIS = Symbol('REDIS');
export const MAILER = Symbol('MAILER');
export const OBJECT_STORAGE = Symbol('OBJECT_STORAGE');
