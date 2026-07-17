import { allowedCoachNames, coachError, requireCoach, setCoachCors } from './_coach-auth.js';

export default async function handler(req, res) {
  setCoachCors(req, res, 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  try {
    const identity = requireCoach(req);
    return res.status(200).json({ ok: true, coach: identity.coach, coaches: allowedCoachNames() });
  } catch (error) {
    return coachError(res, error);
  }
}
