import {useRef, useState, type FormEvent} from 'react';
import {ShoppingBag, UserRound, Plus, Minus, Trash2, Check, ArrowRight, Download, LogOut, ShieldCheck} from 'lucide-react';
import type {BackendState, BackendActions, Profile, Order} from '@/lib/types';
import {appointmentDate} from './doctors';

const emptyProfile: Profile = {name: '', email: '', phone: '', address: '', city: '', pin: ''};
const money = (amount: number) => `₹${amount.toLocaleString('en-IN')}`;
const profileFields = [
  {key: 'name', label: 'Full name', type: 'text', autoComplete: 'name'},
  {key: 'email', label: 'Email address', type: 'email', autoComplete: 'email'},
  {key: 'phone', label: 'Mobile number', type: 'tel', autoComplete: 'tel'},
  {key: 'address', label: 'Street address', type: 'text', autoComplete: 'street-address'},
  {key: 'city', label: 'City', type: 'text', autoComplete: 'address-level2'},
  {key: 'pin', label: 'PIN code', type: 'text', autoComplete: 'postal-code'},
] as const;

interface Props {
  mode: 'cart' | 'account';
  state: BackendState;
  busy: boolean;
  actions: BackendActions;
  onBrowse: () => void;
  onManageLogin?: () => void;
  onLogin?: () => void;
}

export function Commerce({mode, state, busy, actions, onBrowse, onManageLogin, onLogin}: Props) {
  const {products, cart, profile, orders, appointments, doctors, prescriptions} = state;
  const [draft, setDraft] = useState(profile);
  const [step, setStep] = useState<'bag' | 'checkout' | 'done'>('bag');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [confirmed, setConfirmed] = useState<Order | null>(null);
  const [coupon, setCoupon] = useState('');
  const [applied, setApplied] = useState(false);
  const [pending, setPending] = useState(false);
  const mutationInProgress = useRef(false);
  const disabled = busy || pending;
  const items = products.filter(product => cart[product.id] > 0);
  const count = items.reduce((sum, product) => sum + cart[product.id], 0);
  const subtotal = items.reduce((sum, product) => sum + product.price * cart[product.id], 0);
  const discount = applied ? Math.round(subtotal * 0.1) : 0;
  const shipping = subtotal - discount >= 499 ? 0 : 49;
  const total = subtotal - discount + shipping;

  async function run(action: () => Promise<void>, successMessage = '') {
    if (mutationInProgress.current || busy) return;
    mutationInProgress.current = true;
    setPending(true);
    setError('');
    setMessage('');
    try {
      await action();
      setMessage(successMessage);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Something went wrong. Please try again.');
    } finally {
      mutationInProgress.current = false;
      setPending(false);
    }
  }

  function saveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void run(() => actions.saveProfile(draft), 'Profile and delivery address saved.');
  }

  function checkout(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void run(async () => {
      const order = await actions.placeOrder(draft, applied ? 'WELCOME10' : '');
      setConfirmed(order);
      setStep('done');
    });
  }

  function deleteProfile() {
    if (!window.confirm('Clear your saved profile, demo order history, appointments and uploaded prescriptions? Your sign-in and cart will stay.')) return;
    void run(async () => {
      await actions.deleteProfile();
      setDraft(emptyProfile);
    }, 'Your saved profile and history have been cleared.');
  }

  const fields = (
    <div className="profile-fields">
      {profileFields.map(({key, label, type, autoComplete}) => (
        <label key={key}>
          {label}
          <input
            required
            type={type}
            autoComplete={autoComplete}
            value={draft[key]}
            pattern={key === 'phone' ? '[6-9][0-9]{9}' : key === 'pin' ? '[0-9]{6}' : key === 'name' || key === 'city' ? '.*\\S.*' : undefined}
            minLength={key === 'address' ? 5 : undefined}
            maxLength={key === 'phone' ? 10 : key === 'pin' ? 6 : key === 'name' ? 100 : 200}
            inputMode={key === 'phone' || key === 'pin' ? 'numeric' : undefined}
            onChange={event => setDraft(current => ({...current, [key]: event.target.value}))}
          />
        </label>
      ))}
    </div>
  );

  const summary = (
    <div className="order-summary">
      <div><span>Subtotal ({count} items)</span><b>{money(subtotal)}</b></div>
      {applied && <div className="saving"><span>WELCOME10 savings</span><b>−{money(discount)}</b></div>}
      <div><span>Demo delivery</span><b>{shipping ? money(shipping) : 'Free'}</b></div>
      <div className="grand-total"><b>Total</b><strong>{money(total)}</strong></div>
      <small>Free demo delivery from ₹499 after discounts. Final totals are confirmed when you place your order.</small>
    </div>
  );

  return (
    <div className="commerce" aria-busy={disabled}>
      <span className="demo-chip">DEMO · NO REAL PAYMENTS OR DELIVERY</span>
      {error && <p role="alert" className="form-message">{error}</p>}
      {message && <p role="status" className="form-message">{message}</p>}
      {mode === 'account' ? (
        <>
          <UserRound className="modal-icon" />
          <h2>{profile.name ? `Hello, ${profile.name.split(' ')[0]}` : 'Your Osudh24 profile'}</h2>
          <p>Save your contact details and delivery address for a faster demo checkout.</p>
          {state.auth.user && (
            <div className="auth-identity">
              <p><ShieldCheck size={15} /> Signed in as <b>{state.auth.user.name || state.auth.user.email || state.auth.user.phone || 'Osudh24 member'}</b></p>
              {state.auth.user.email && <p>Verified email: {state.auth.user.email}</p>}
              {state.auth.user.phone && <p>Verified mobile: {state.auth.user.phone}</p>}
              <p>{state.auth.user.providers.map(provider => <span className="auth-provider-badge" key={provider}>{provider === 'google' ? 'Google' : 'Mobile OTP'}</span>)}</p>
              <small>Your verified sign-in details are separate from the contact details below.</small>
              {onManageLogin && state.auth.user.providers.length < 2 && <button disabled={disabled} className="secondary-action" onClick={onManageLogin}>Add a sign-in method <ArrowRight size={15} /></button>}
              <button disabled={disabled} className="secondary-action" onClick={() => void run(() => actions.signOut())}><LogOut size={15} /> Sign out</button>
            </div>
          )}
          <form onSubmit={saveProfile}>
            <h3>Personal details & delivery address</h3>
            <fieldset className="form-fields" disabled={disabled}>
              {fields}
              <button className="primary">{pending ? 'Saving…' : 'Save profile'} <Check size={16} /></button>
            </fieldset>
          </form>

          <h3 className="history-title">Your demo appointments</h3>
          {appointments.length ? appointments.map(appointment => (
            <article className="history-order appointment-entry" key={appointment.id}>
              <div>
                <b>{doctors.find(doctor => doctor.id === appointment.doctorId)?.name}</b>
                <span className={appointment.status === 'Cancelled' ? 'cancelled-status' : 'booked-status'}>{appointment.status}</span>
              </div>
              <p>
                {appointmentDate(appointment.date)} · {appointment.time} IST · Demo video visit<br />
                Patient: {appointment.patient}<br />
                Reference: {appointment.id} · Demo fee {money(appointment.fee)}
              </p>
              {appointment.status === 'Booked' && (
                <button disabled={disabled} className="danger-link" onClick={() => void run(() => actions.cancelAppointment(appointment.id), 'Demo appointment cancelled.')}>
                  Cancel appointment
                </button>
              )}
            </article>
          )) : <p>No appointments yet. Visit Consult doctors to book a demo appointment.</p>}

          <h3 className="history-title">Demo order history</h3>
          {orders.length ? orders.map(order => (
            <details className="history-order" key={order.id}>
              <summary>
                <span>{order.id}<small>{new Date(order.date).toLocaleDateString('en-IN')} · {order.status}</small></span>
                <b>{money(order.total)}</b>
              </summary>
              <p>{order.address}</p>
              {order.items.map((item, index) => (
                <div className="history-item" key={`${item.name}-${index}`}>
                  <span>{item.name} × {item.quantity}</span><b>{money(item.price * item.quantity)}</b>
                </div>
              ))}
              <div className="history-item"><span>Delivery</span><b>{order.shipping ? money(order.shipping) : 'Free'}</b></div>
              {order.discount > 0 && <div className="history-item"><span>Discount</span><b>−{money(order.discount)}</b></div>}
              {order.status !== 'Cancelled' && (
                <button disabled={disabled} type="button" className="danger-link" onClick={() => void run(() => actions.cancelOrder(order.id), 'Demo order cancelled.')}>
                  Cancel demo order
                </button>
              )}
            </details>
          )) : <p>No demo orders yet. Your completed demo checkouts appear here.</p>}

          <h3 className="history-title">Your prescriptions</h3>
          {prescriptions.length ? prescriptions.map(prescription => (
            <article className="history-order prescription-entry" key={prescription.id}>
              <b>{prescription.name}</b>
              <p>{new Date(prescription.createdAt).toLocaleDateString('en-IN')} · {Math.max(1, Math.round(prescription.size / 1024))} KB<br />Saved to your profile. Pharmacist review is not available.</p>
              <a className="secondary-action" href={`/api/prescriptions/${encodeURIComponent(prescription.id)}/file`} download>
                <Download size={14} /> Download
              </a>
              <button disabled={disabled} className="danger-link" onClick={() => void run(() => actions.deletePrescription(prescription.id), 'Prescription deleted.')}>
                <Trash2 size={12} /> Delete prescription
              </button>
            </article>
          )) : <p>No prescriptions uploaded yet.</p>}
          <button className="secondary-action" onClick={onBrowse}>Explore medicines <ArrowRight size={15} /></button>
          <button disabled={disabled} className="danger-link" onClick={deleteProfile}>Clear saved profile & history</button>
        </>
      ) : (
        <>
          <ShoppingBag className="modal-icon" />
          <h2>{step === 'done' ? 'Demo order created' : step === 'checkout' ? 'Delivery & review' : 'Your care bag'}</h2>
          {step === 'done' && confirmed ? (
            <div className="confirmation">
              <Check /><h3>{confirmed.id}</h3>
              <p>Your demo order is saved in Profile → Order history. No payment was collected and nothing will be delivered.</p>
              <strong>{money(confirmed.total)}</strong>
              <button className="primary" onClick={onBrowse}>Continue shopping</button>
            </div>
          ) : !items.length ? (
            <div className="empty-bag">
              <p>Your bag is empty. Add something for your daily routine.</p>
              <button className="primary" onClick={onBrowse}>Explore medicines <ArrowRight size={16} /></button>
            </div>
          ) : step === 'checkout' ? (
            <>
              <button disabled={disabled} className="secondary-action" onClick={() => setStep('bag')}>← Back to bag</button>
              <form onSubmit={checkout}>
                <fieldset className="form-fields" disabled={disabled}>
                  {fields}
                  {summary}
                  <div className="payment-note"><b>Demo payment</b><p>No card or UPI details needed. This checkout creates a saved sample order.</p></div>
                  <label className="confirm-check"><input type="checkbox" required />I understand this is a demo order with no payment or delivery.</label>
                  <button className="primary">{pending ? 'Placing order…' : `Place demo order · ${money(total)}`} <ArrowRight size={16} /></button>
                </fieldset>
              </form>
            </>
          ) : (
            <>
              {items.map(product => (
                <div className="cart-row" key={product.id}>
                  <div>
                    <b>{product.name}</b><small>{product.size} · {money(product.price)} each</small>
                    <button disabled={disabled} className="remove-item" aria-label={`Remove ${product.name}`} onClick={() => void run(() => actions.removeCartItem(product.id))}>
                      <Trash2 size={12} /> Remove
                    </button>
                  </div>
                  <div>
                    <b>{money(product.price * cart[product.id])}</b>
                    <div className="quantity">
                      <button disabled={disabled} aria-label={`Decrease ${product.name}`} onClick={() => void run(() => actions.changeCart(product.id, -1))}><Minus size={13} /></button>
                      {cart[product.id]}
                      <button disabled={disabled || cart[product.id] >= 99} aria-label={`Increase ${product.name}`} onClick={() => void run(() => actions.changeCart(product.id, 1))}><Plus size={13} /></button>
                    </div>
                  </div>
                </div>
              ))}
              <form className="coupon-form" onSubmit={event => {
                event.preventDefault();
                const valid = coupon.trim().toUpperCase() === 'WELCOME10';
                setApplied(valid);
                setError(valid ? '' : 'Code not found. Try WELCOME10 for 10% off.');
                setMessage(valid ? '10% demo discount applied.' : '');
              }}>
                <label>Demo coupon<input disabled={disabled} value={coupon} onChange={event => setCoupon(event.target.value)} placeholder="Try WELCOME10" /></label>
                <button disabled={disabled} type="submit" className="secondary-action">Apply</button>
              </form>
              {applied && <button disabled={disabled} className="secondary-action" onClick={() => {setApplied(false); setMessage('Coupon removed.');}}>Remove coupon</button>}
              {summary}
              <button disabled={disabled} className="primary" onClick={() => {
                if (!state.auth.user) {onLogin?.(); return;}
                setDraft(profile); setStep('checkout'); setMessage(''); setError('');
              }}>
                {state.auth.user ? 'Continue to demo checkout' : 'Sign in to checkout'} <ArrowRight size={16} />
              </button>
              <button className="secondary-action" onClick={onBrowse}>Continue shopping</button>
            </>
          )}
        </>
      )}
    </div>
  );
}
