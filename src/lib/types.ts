export interface Product {
  id: number;
  name: string;
  type: string;
  size: string;
  price: number;
  old: number;
  color: string;
  label: string;
  sub: string;
}

export interface Doctor {
  id: string;
  name: string;
  specialty: string;
  qualification: string;
  experience: number;
  fee: number;
  languages: string;
  about: string;
  initials: string;
}

export interface Profile {
  name: string;
  email: string;
  phone: string;
  address: string;
  city: string;
  pin: string;
}

export interface Order {
  id: string;
  date: string;
  items: { name: string; quantity: number; price: number }[];
  subtotal: number;
  discount: number;
  shipping: number;
  total: number;
  status: 'Demo placed' | 'Cancelled';
  address: string;
}

export interface Appointment {
  id: string;
  doctorId: string;
  patient: string;
  date: string;
  time: string;
  fee: number;
  status: 'Booked' | 'Cancelled';
}

export interface Prescription {
  id: string;
  name: string;
  mime: string;
  size: number;
  createdAt: string;
}

export type AuthProvider = 'google' | 'mobile';

export interface AuthUser {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  providers: AuthProvider[];
}

export interface AuthState {
  user: AuthUser | null;
  providers: { google: boolean; mobile: boolean };
  mobileMethod: 'widget' | 'otp' | null;
  sessionExpiresAt: string | null;
}

export interface OtpChallenge {
  challengeId: string;
  expiresAt: string;
  retryAfter: number;
}

export interface BackendState {
  auth: AuthState;
  products: Product[];
  doctors: Doctor[];
  profile: Profile;
  cart: Record<number, number>;
  orders: Order[];
  appointments: Appointment[];
  prescriptions: Prescription[];
  availability: {
    dates: string[];
    times: string[];
    booked: { doctorId: string; date: string; time: string }[];
  };
  locationPin: string;
  newsletterEmail: string;
}

export interface BackendActions {
  signInWithGoogle(idToken: string, mode?: 'login' | 'link'): Promise<void>;
  signInWithMsg91(accessToken: string, mode?: 'login' | 'link'): Promise<void>;
  sendOtp(mobile: string, mode?: 'login' | 'link'): Promise<OtpChallenge>;
  verifyOtp(challengeId: string, otp: string): Promise<void>;
  signOut(): Promise<void>;
  changeCart(productId: number, delta: number): Promise<void>;
  removeCartItem(productId: number): Promise<void>;
  saveProfile(profile: Profile): Promise<void>;
  placeOrder(profile: Profile, coupon: string): Promise<Order>;
  cancelOrder(id: string): Promise<void>;
  bookAppointment(input: { doctorId: string; patient: string; date: string; time: string }): Promise<Appointment>;
  cancelAppointment(id: string): Promise<void>;
  deleteProfile(): Promise<void>;
  uploadPrescription(file: File): Promise<void>;
  deletePrescription(id: string): Promise<void>;
  saveLocation(pin: string): Promise<void>;
  subscribe(email: string): Promise<void>;
  refresh(): Promise<void>;
}

export const emptyProfile: Profile = { name: '', email: '', phone: '', address: '', city: '', pin: '' };
