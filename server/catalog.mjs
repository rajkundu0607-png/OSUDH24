export const products = [
  { id: 1, name: 'Daily multivitamin', type: 'Vitamins & supplements', size: '60 tablets', price: 299, old: 399, color: 'orange', label: 'DAILY\nMULTI', sub: 'VITAMINS + MINERALS' },
  { id: 2, name: 'Digital blood pressure monitor', type: 'Health devices', size: '1 device', price: 1299, old: 1599, color: 'blue', label: 'BP\nMONITOR', sub: 'HOME HEALTHCARE' },
  { id: 3, name: 'Gentle daily cleanser', type: 'Skin & personal care', size: '125 ml', price: 249, old: 325, color: 'green', label: 'gentle\ncleanser', sub: 'DAILY SKIN ESSENTIALS' },
  { id: 4, name: 'Pure aloe vera gel', type: 'Ayurveda & wellness', size: '150 ml', price: 179, old: 225, color: 'lime', label: 'ALOE\nVERA', sub: 'NATURE’S EVERYDAY CARE' },
];

export const doctors = [
  { id: 'ananya', name: 'Dr. Ananya Sen', specialty: 'General physician', qualification: 'MBBS, MD · General Medicine', experience: 9, fee: 499, languages: 'English, Hindi, Bengali', about: 'Everyday health concerns, preventive care and general wellness guidance.', initials: 'AS' },
  { id: 'rohan', name: 'Dr. Rohan Mehta', specialty: 'Dermatology', qualification: 'MBBS, MD · Dermatology', experience: 11, fee: 699, languages: 'English, Hindi', about: 'Skin, hair and nail concerns, with a focus on everyday skin health.', initials: 'RM' },
  { id: 'ishita', name: 'Dr. Ishita Das', specialty: 'Pediatrics', qualification: 'MBBS, MD · Pediatrics', experience: 8, fee: 599, languages: 'English, Bengali', about: 'Child health, development and routine care guidance for parents.', initials: 'ID' },
  { id: 'arjun', name: 'Dr. Arjun Rao', specialty: 'Cardiology', qualification: 'MBBS, MD, DM · Cardiology', experience: 14, fee: 899, languages: 'English, Hindi', about: 'Heart health, blood pressure concerns and preventive cardiac care.', initials: 'AR' },
];

export const emptyProfile = { name: '', email: '', phone: '', address: '', city: '', pin: '' };
export const appointmentTimes = ['10:00', '11:30', '14:00', '16:30'];

export function appointmentDates(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const part = type => parts.find(item => item.type === type).value;
  const today = new Date(`${part('year')}-${part('month')}-${part('day')}T00:00:00Z`);
  return Array.from({ length: 7 }, (_, index) => {
    const day = new Date(today);
    day.setUTCDate(day.getUTCDate() + index + 1);
    return day.toISOString().slice(0, 10);
  });
}
