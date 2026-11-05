// VENDORED, DO NOT EDIT. Verbatim copy of dp-athlete-portal api/_lib/garmin-workouts.js
// with the session-type list restored (portal commit 94e049e, re-shipped in the
// portal-restore-run-session-types ZIP). sha256 of the portal file: 12f12847bd41ee58...
// Used only by tests/run-workout-contract.test.js so the builder is checked
// against the converter itself, not a description of it. When the portal file
// changes, copy it here again and rerun npm test.
// Garmin Training API V2 2.0 (22 October 2026). Coach prescriptions only.
import { createHash } from 'node:crypto';
export function workoutError(message, status = 422) { return Object.assign(new Error(message), { status, publicMessage: message }); }
const positive = value => Number.isFinite(Number(value)) && Number(value) > 0;
const text = value => String(value || '').trim();
function paceSeconds(value) {
  const match = /^(\d{1,2}):([0-5]\d)(?:\s*(?:\/km|min\/km))?$/.exec(text(value));
  if (!match) throw workoutError('A pace target must use minutes:seconds per kilometre.');
  const seconds = Number(match[1]) * 60 + Number(match[2]);
  if (seconds < 90 || seconds > 1800) throw workoutError('A pace target is outside the supported running range.');
  return seconds;
}
export function validWorkoutDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value)) || new Date(value+'T12:00:00Z').toISOString().slice(0,10) !== value) throw workoutError('The session needs a valid calendar date.');
  return value;
}
// Running session types the coaches dashboard programmes. The planner stores
// the run's purpose as its type (Easy Effort, Tempo, Long Run...), so an exact
// "run" match refused almost every real run. Mixed or admin rows (Brick,
// Run + Strength, Optional, Weekly KM Total) are not one running workout and
// stay out. Keep in step with GARMIN_RUN_SESSION_TYPES in the dashboard's
// public/run-workout.js.
export const GARMIN_RUN_SESSION_TYPES = new Set(['run','running','easy','easy effort','recovery','long','long run','tempo','threshold','speed','interval','intervals','vo2','fartlek','hills','mp','race','time trial']);
export function buildRunningWorkout(session, rows) {
  if (!session || !GARMIN_RUN_SESSION_TYPES.has(text(session.session_type).toLowerCase())) throw workoutError('Only running sessions can be sent to Garmin.');
  if (session.prescription_mode !== 'structured' || !Array.isArray(rows) || !rows.length) throw workoutError('Ask your coach to add structured run steps before sending this session to Garmin.');
  if (rows.length > 100) throw workoutError('Garmin supports at most 100 workout steps.');
  const ids = new Set(rows.map(row=>String(row.id)));
  if (ids.size !== rows.length || rows.some(row=>!row.id || (row.parent_step_id && !ids.has(String(row.parent_step_id))))) throw workoutError('The run steps contain missing or duplicate references.');
  const seen = new Set(); let order = 0; let expanded = 0;
  function convert(parent, depth = 0, multiplier = 1) {
    if (depth > 2) throw workoutError('Nested repeats are too deep for this workout.');
    return rows.filter(row=>String(row.parent_step_id || '') === parent).sort((a,b)=>Number(a.step_order || 0)-Number(b.step_order || 0)).map(row=>{
      if (seen.has(row.id)) throw workoutError('The run steps contain a repeated reference.');
      seen.add(row.id); const stepOrder = ++order;
      if (row.step_type === 'repeat') {
        const count = Number(row.repeat_count);
        if (!Number.isInteger(count) || count < 1 || count > 100) throw workoutError('Repeat counts must be between 1 and 100.');
        const steps = convert(String(row.id), depth+1, multiplier*count);
        if (!steps.length) throw workoutError('A repeat block needs at least one child step.');
        return {type:'WorkoutRepeatStep',stepOrder,repeatType:'REPEAT_UNTIL_STEPS_CMPLT',repeatValue:count,steps};
      }
      expanded += multiplier;
      if (expanded > 100) throw workoutError('This workout exceeds 100 steps after repeats.');
      const intensities = {warmup:'WARMUP',run:'ACTIVE',interval:'INTERVAL',recovery:'RECOVERY',rest:'REST',cooldown:'COOLDOWN'};
      if (!intensities[row.step_type]) throw workoutError('A run step has an unsupported type.');
      if (positive(row.distance_km) && positive(row.duration_sec)) throw workoutError('Choose either distance or time for each run step.');
      const distance = positive(row.distance_km), duration = positive(row.duration_sec);
      if ((row.distance_km != null && !distance) || (row.duration_sec != null && !duration)) throw workoutError('Step distances and durations must be positive.');
      const step = {type:'WorkoutStep',stepOrder,intensity:intensities[row.step_type],description:text(row.instructions).slice(0,512),durationType:distance?'DISTANCE':duration?'TIME':'OPEN',durationValue:distance?Number(row.distance_km)*1000:duration?Number(row.duration_sec):null,targetType:'OPEN'};
      const target = text(row.intensity_type).toLowerCase();
      if (target === 'pace' || target === 'pace_range') {
        const a=paceSeconds(row.pace_min),b=paceSeconds(row.pace_max || row.pace_min);
        step.targetType='PACE';step.targetValueLow=1000/Math.max(a,b);step.targetValueHigh=1000/Math.min(a,b);
      } else if (target === 'hr' || target === 'hr_zone') {
        const zone = /^(?:z(?:one)?\s*)?([1-5])$/i.exec(text(row.hr_zone));
        if (!zone) throw workoutError('Heart-rate targets must specify a Garmin zone from 1 to 5.');
        step.targetType='HEART_RATE';step.targetValue=Number(zone[1]);
      } else if (target === 'rpe') {
        if (!positive(row.rpe) || Number(row.rpe)>10) throw workoutError('RPE targets must be between 1 and 10.');
        step.description=('RPE '+Number(row.rpe)+'/10. '+step.description).slice(0,512);
      } else if (target === 'effort' || target === 'text') {
        step.description=(text(row.effort)+' '+step.description).trim().slice(0,512);
      } else if (target) throw workoutError('A run step has an unsupported intensity target.');
      return step;
    });
  }
  const steps = convert('');
  if (!steps.length || seen.size !== rows.length) throw workoutError('The run steps contain disconnected or cyclic blocks.');
  return {workoutName:text(session.title || 'DP Run').slice(0,100),description:'Running session programmed by Dual Performance.',sport:'RUNNING',workoutProvider:'Dual Performance',workoutSourceId:'Dual Performance',segments:[{segmentOrder:1,sport:'RUNNING',steps}]};
}

/** Persist each remote id before the next API call. Unknown POST outcomes fail
 * closed; retrying a lost response must never silently create duplicate workouts. */
export async function deliverWorkout({session,steps,date,athleteCode}, {read,save,request}) {
  validWorkoutDate(date);
  const workout=buildRunningWorkout(session,steps);
  const fingerprint=createHash('sha256').update(JSON.stringify({workout,date})).digest('hex');
  let receipt=await read();
  if (receipt && ['creating','scheduling'].includes(receipt.state)) throw workoutError('Delivery is uncertain. Check Garmin Connect and contact your coach before sending again.',409);
  if (receipt && receipt.state==='sent' && receipt.fingerprint===fingerprint) return receipt;
  const persist=async changes=>{await save(changes);receipt={...receipt,...changes};};
  if (!receipt?.workout_id) {
    await persist({athlete_code:athleteCode,planned_session_id:session.id,state:'creating'});
    let created;
    try { created=await request('/workoutportal/workout/v2','POST',workout); }
    catch(error){if(error.status>=400 && error.status<500)await persist({state:'retryable'});throw error;}
    if (!created?.workoutId || !created?.ownerId) throw workoutError('Garmin did not confirm the workout ID. Check Garmin Connect before sending again.',409);
    await persist({workout_id:String(created.workoutId),owner_id:String(created.ownerId),state:'ready'});
  } else {
    // Full object, with ownerId required by Garmin's update contract.
    await request('/training-api/workout/v2/'+encodeURIComponent(receipt.workout_id),'PUT',{...workout,workoutId:Number(receipt.workout_id),ownerId:Number(receipt.owner_id)});
  }
  const schedule={workoutId:Number(receipt.workout_id),date};
  if (receipt.schedule_id) {
    await request('/training-api/schedule/'+encodeURIComponent(receipt.schedule_id),'PUT',{...schedule,scheduleId:Number(receipt.schedule_id)});
  } else {
    await persist({state:'scheduling'});
    let created;
    try {created=await request('/training-api/schedule/','POST',schedule);}
    catch(error){if(error.status>=400 && error.status<500)await persist({state:'ready'});throw error;}
    if (!created?.scheduleId) throw workoutError('Garmin did not confirm the calendar entry. Check Garmin Connect before sending again.',409);
    await persist({schedule_id:String(created.scheduleId),state:'ready'});
  }
  await persist({state:'sent',scheduled_date:date,fingerprint,sent_at:new Date().toISOString()});
  return receipt;
}
