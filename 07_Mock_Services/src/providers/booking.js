import { Router } from 'express';

const bookings = new Map();
let nextId = 900;

export const reset = () => { bookings.clear(); nextId = 900; };
export const dump = () => ({ bookings: [...bookings.values()] });

export function create({ lead_id, booking_id, starts_at, rep_id }) {
  const id = booking_id ?? `BK-${nextId++}`;
  const booking = {
    booking_id: id,
    lead_id,
    rep_id: rep_id ?? null,
    starts_at: starts_at ?? new Date(Date.now() + 86_400_000).toISOString(),
    status: 'confirmed',
    created_at: new Date().toISOString(),
  };
  bookings.set(id, booking);
  return booking;
}

export const router = Router();

router.get('/:id', (req, res) => {
  const b = bookings.get(req.params.id);
  if (!b) return res.status(404).json({ error: 'not_found' });
  res.json(b);
});
