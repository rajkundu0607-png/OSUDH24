import {useEffect, useRef, useState, type FormEvent} from 'react';
import {Stethoscope, ArrowRight, Check, Video, UserRound} from 'lucide-react';
import type {BackendState, BackendActions, Appointment} from '@/lib/types';

export function appointmentDate(date: string) {
  return new Date(`${date}T12:00:00+05:30`).toLocaleDateString('en-IN', {
    day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata',
  });
}

interface Props {
  state: BackendState;
  busy: boolean;
  actions: BackendActions;
  onProfile: () => void;
}

export function Doctors({state, busy, actions, onProfile}: Props) {
  const {doctors, availability, profile} = state;
  const [filter, setFilter] = useState('All');
  const [selected, setSelected] = useState<string | null>(null);
  const [details, setDetails] = useState<string | null>(null);
  const [date, setDate] = useState(availability.dates[0] || '');
  const [time, setTime] = useState('');
  const [patient, setPatient] = useState(profile.name);
  const [confirmed, setConfirmed] = useState<Appointment | null>(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const mutationInProgress = useRef(false);
  const disabled = busy || pending;
  const doctor = doctors.find(item => item.id === selected);
  const selectedDate = availability.dates.includes(date) ? date : availability.dates[0] || '';
  const booked = (slot: string) => availability.booked.some(item => item.doctorId === selected && item.date === selectedDate && item.time === slot);

  useEffect(() => {
    let active = true;
    void actions.refresh().catch(cause => {
      if (active) setError(cause instanceof Error ? cause.message : 'Could not load available appointments. Please try again.');
    });
    return () => {active = false;};
  }, [actions.refresh]);

  async function book(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (mutationInProgress.current || busy || !doctor) return;
    if (!patient.trim() || !selectedDate || !time || booked(time)) {
      setError('Choose a patient name and an available date and time.');
      return;
    }
    mutationInProgress.current = true;
    setPending(true);
    setError('');
    try {
      const appointment = await actions.bookAppointment({doctorId: doctor.id, patient: patient.trim(), date: selectedDate, time});
      setConfirmed(appointment);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'Could not book this appointment. Please try again.';
      try {await actions.refresh();} catch { /* Keep the original booking error visible. */ }
      setError(message);
      setTime('');
    } finally {
      mutationInProgress.current = false;
      setPending(false);
    }
  }

  function selectDoctor(id: string) {
    setSelected(id);
    setTime('');
    setError('');
    void actions.refresh().catch(cause => setError(cause instanceof Error ? cause.message : 'Could not refresh availability.'));
  }

  return (
    <div className="commerce doctors" aria-busy={disabled}>
      <span className="demo-chip">FICTIONAL DOCTORS · DEMO BOOKINGS</span>
      <Stethoscope className="modal-icon" />
      <h2>Consult doctors</h2>
      <p>Explore sample profiles and reserve a saved demo appointment. No real doctor, payment or video call is connected.</p>
      {error && <p role="alert" className="form-message">{error}</p>}
      {confirmed ? (
        <div className="confirmation">
          <Check /><h3>Demo appointment booked</h3>
          <p>
            {doctors.find(item => item.id === confirmed.doctorId)?.name}<br />
            {appointmentDate(confirmed.date)} · {confirmed.time} IST<br />
            Patient: {confirmed.patient}<br />Reference: {confirmed.id}
          </p>
          <p>Your appointment is saved in your profile. No payment was collected, and no reminder or consultation will occur.</p>
          <button className="primary" onClick={onProfile}>View appointments in profile <ArrowRight size={16} /></button>
          <button className="secondary-action" onClick={() => {setConfirmed(null); setSelected(null); setTime('');}}>Explore more doctors</button>
        </div>
      ) : doctor ? (
        <>
          <button disabled={disabled} className="secondary-action" onClick={() => {setSelected(null); setTime(''); setError('');}}>← All doctors</button>
          <h3>{doctor.name}</h3><p>{doctor.specialty} · Demo fee ₹{doctor.fee}</p>
          <form onSubmit={book}>
            <fieldset className="form-fields" disabled={disabled}>
              <label>Patient name<input required maxLength={100} pattern=".*\S.*" value={patient} onChange={event => setPatient(event.target.value)} /></label>
              <label>
                Appointment date
                <select required value={selectedDate} onChange={event => {setDate(event.target.value); setTime(''); setError('');}}>
                  {availability.dates.map(day => <option key={day} value={day}>{appointmentDate(day)}</option>)}
                </select>
              </label>
              <fieldset className="appointment-slots">
                <legend>Available times · India Standard Time</legend>
                {availability.times.map(slot => (
                  <button type="button" key={slot} disabled={booked(slot)} aria-pressed={time === slot} onClick={() => setTime(slot)}>
                    {slot}{booked(slot) ? ' · Booked' : ''}
                  </button>
                ))}
              </fieldset>
              <p className="slot-note">Availability for the next seven days. Times are in IST.</p>
              <label className="confirm-check"><input type="checkbox" required />I understand this is a demo booking with no real consultation or payment.</label>
              <button className="primary" disabled={!time || !selectedDate || booked(time)}>
                {pending ? 'Booking…' : 'Confirm demo appointment'} <ArrowRight size={16} />
              </button>
            </fieldset>
          </form>
        </>
      ) : (
        <>
          <div className="filters" aria-label="Filter doctors by specialty">
            {['All', ...new Set(doctors.map(item => item.specialty))].map(specialty => (
              <button aria-pressed={filter === specialty} className={filter === specialty ? 'selected' : ''} key={specialty} onClick={() => setFilter(specialty)}>
                {specialty === 'All' ? 'All specialties' : specialty}
              </button>
            ))}
          </div>
          <div className="doctor-grid">
            {doctors.filter(item => filter === 'All' || item.specialty === filter).map(item => (
              <article className="doctor-card" key={item.id}>
                <div className="doctor-avatar" aria-hidden="true"><UserRound /><span>{item.initials}</span></div>
                <div>
                  <span className="doctor-specialty">{item.specialty}</span><h3>{item.name}</h3>
                  <p>{item.experience} years of sample experience<br />{item.languages}</p>
                </div>
                <button className="secondary-action" aria-expanded={details === item.id} onClick={() => setDetails(details === item.id ? null : item.id)}>
                  {details === item.id ? 'Hide profile' : 'View profile'}
                </button>
                {details === item.id && <div className="doctor-bio"><b>{item.qualification}</b><p>{item.about}</p><small>Fictional profile for demonstration; credentials are illustrative.</small></div>}
                <div className="doctor-fee"><span><Video size={14} /> Demo video visit</span><b>₹{item.fee}</b></div>
                <button disabled={disabled} className="primary" aria-label={`Book appointment with ${item.name}`} onClick={() => selectDoctor(item.id)}>
                  Book appointment <ArrowRight size={15} />
                </button>
              </article>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
