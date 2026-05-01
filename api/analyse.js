// api/analyse.js — AI coaching analysis via Claude
// Accepts POST with athlete data, returns per-athlete recommendations + squad brief.

const Anthropic = require('@anthropic-ai/sdk');

function buildAthletePromptData(a) {
  const w = a.weekly;
  return {
    id: a.id,
    weekly: w ? {
      weekEnding:          w['Week Ending'],
      energy:              w['Energy /10'],
      sleepHrs:            w['Sleep hrs'],
      soreness:            w['Soreness /10'],
      stress:              w['Stress'],
      motivation:          w['Motivation'],
      nutritionAdherence:  w['Nutrition Adherence /10'],
      fuelling:            w['Fuelling'],
      runPlanned:          w['Run Planned'],
      runCompleted:        w['Run Completed'],
      runKm:               w['Weekly Run KM'],
      runFeel:             w['Run Feel /10'],
      runNiggles:          w['Run Niggles'],
      runWins:             w['Runs Wins'],
      liftPlanned:         w['Lift Planned'],
      liftCompleted:       w['Lift Completed'],
      liftFeel:            w['Lift Feel /10'],
      liftNiggles:         w['Lifts Niggles'],
      liftWins:            w['Lift Wins'],
      upcomingImpact:      w['Upcoming Impact'],
      socialEvent:         w['Social Event Upcoming'],
      testimonial:         w['Testimonial'],
      notes:               w['Notes'],
    } : null,
    body7dAvg: a.bAvg,
    nutrition7dAvg: a.nAvg,
  };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) { res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' }); return; }

  const { athletes } = req.body || {};
  if (!athletes?.length) { res.status(400).json({ error: 'No athletes provided' }); return; }

  const client = new Anthropic({ apiKey });

  // Filter to athletes with at least some data
  const payload = athletes
    .filter(a => a.weekly || a.bAvg?.wt != null)
    .map(buildAthletePromptData);

  if (!payload.length) {
    res.status(400).json({ error: 'No athletes with sufficient data to analyse' });
    return;
  }

  const analysisPrompt = `You are an expert performance coach at Dual Performance — a hybrid running and strength coaching service for competitive amateur athletes.

Analyse the following ${payload.length} athletes using their weekly check-in and 7-day tracking data. Return ONLY a valid JSON array (no other text, no markdown, just the raw JSON array).

ATHLETE DATA:
${JSON.stringify(payload, null, 2)}

Return this exact structure for each athlete:
[
  {
    "id": "ATHLETE_ID",
    "status": "GREEN",
    "flags": ["Flag 1", "Flag 2", "Flag 3"],
    "recommendation": "3-4 sentence coaching recommendation here."
  }
]

STATUS rules:
- RED = immediate attention needed (injury/niggle worsening, stress ≥8, significant training gaps, nutrition very off)
- AMBER = monitoring needed (mild niggle, moderate stress 6-7, 1-2 missed sessions, low motivation)
- GREEN = on track (solid compliance, good recovery scores, positive trends)

flags: 2-4 items mixing positives and concerns — reference actual numbers from their data.
recommendation: specific, actionable advice for THIS athlete THIS week. Reference their actual data. Practical, direct, coach-to-coach tone.`;

  try {
    // Per-athlete analysis
    const analysisMsg = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 3000,
      messages: [{ role: 'user', content: analysisPrompt }],
    });

    const rawText = analysisMsg.content[0].text.trim();
    const jsonMatch = rawText.match(/\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error('AI response was not valid JSON — try again');
    const analyses = JSON.parse(jsonMatch[0]);

    // Squad brief
    const redAthletes  = analyses.filter(a => a.status === 'RED').map(a => a.id);
    const amberAthletes = analyses.filter(a => a.status === 'AMBER').map(a => a.id);

    const briefPrompt = `You are writing a weekly coaching staff brief for Dual Performance.

Squad summary:
- RED (immediate attention): ${redAthletes.join(', ') || 'none'}
- AMBER (monitoring): ${amberAthletes.join(', ') || 'none'}
- GREEN (on track): ${analyses.filter(a => a.status === 'GREEN').map(a => a.id).join(', ') || 'none'}

Individual analyses:
${analyses.map(a => `${a.id} (${a.status}): ${a.recommendation}`).join('\n\n')}

Write a 4-5 sentence coaching staff brief. Cover: (1) who needs most attention and why, (2) any squad-wide patterns worth noting, (3) top 2-3 priority actions for the coaching team this week. Be direct and practical — this is for coaches, not athletes.`;

    const briefMsg = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 500,
      messages: [{ role: 'user', content: briefPrompt }],
    });

    res.status(200).json({
      analyses,
      squadBrief: briefMsg.content[0].text.trim(),
    });

  } catch (e) {
    console.error('[analyse]', e.message);
    res.status(500).json({ error: e.message });
  }
};
