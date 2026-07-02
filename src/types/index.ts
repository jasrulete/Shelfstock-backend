export type UserRole = 'customer' | 'admin';

export interface User {
  id: number;
  email: string;
  password_hash: string;
  role: UserRole;
  created_at: string;
}

export interface PublicUser {
  id: number;
  email: string;
  role: UserRole;
}

export interface Product {
  id: number;
  name: string;
  description: string | null;
  price: string; // numeric comes back from pg as string; parse when doing math
  category: string;
  stock: number;
  image_url: string | null;
  created_at: string;
}

export interface Order {
  id: number;
  user_id: number;
  total_amount: string;
  currency: string;
  status: 'pending' | 'completed' | 'cancelled';
  created_at: string;
}

export interface OrderItem {
  id: number;
  order_id: number;
  product_id: number;
  quantity: number;
  price_at_purchase: string;
}

export interface JwtPayload {
  userId: number;
  role: UserRole;
}

// Augment Express's Request type so req.user is known throughout the app
declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload;
    }
  }
}
