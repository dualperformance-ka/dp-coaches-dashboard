#!/usr/bin/env python3
"""Generate the commercial-gym exercise library migration.

Names are the join key between a prescription and an athlete's history
(training_session_logs matches on name, and the portal's swap logic keys off it
too), so this only ever ADDS. ON CONFLICT (match_key) DO NOTHING means the 119
exercises already in use are never renamed or reclassified.
"""
import re, sys

# category -> [(name, equipment)]
LIB = {}

def add(cat, equip, *names):
    LIB.setdefault(cat, []).extend((n, equip) for n in names)

# ── CHEST ────────────────────────────────────────────────────────────────────
add('Chest', 'Barbell', 'Barbell Bench Press', 'Barbell Decline Bench Press',
    'Barbell Floor Press', 'Barbell Pin Press', 'Barbell Pullover')
add('Chest', 'Dumbbell', 'Dumbbell Bench Press', 'Dumbbell Decline Press',
    'Dumbbell Floor Press', 'Dumbbell Pullover', 'Single Arm Dumbbell Press')
add('Chest', 'Cable', 'Cable Crossover', 'High to Low Cable Fly', 'Low to High Cable Fly',
    'Single Arm Cable Fly', 'Standing Cable Press')
add('Chest', 'Machine', 'Chest Press Machine', 'Seated Chest Press Machine',
    'Decline Chest Press Machine', 'Converging Chest Press')
add('Chest', 'Plate-loaded', 'Plate Loaded Chest Press', 'Plate Loaded Incline Press',
    'Plate Loaded Decline Press', 'Hammer Strength Chest Press', 'Hammer Strength Incline Press')
add('Chest', 'Smith machine', 'Smith Machine Bench Press', 'Smith Machine Decline Press')
add('Chest', 'Bodyweight', 'Push Up', 'Incline Push Up', 'Decline Push Up',
    'Deficit Push Up', 'Weighted Push Up', 'Chest Dip', 'Weighted Chest Dip')
add('Chest', 'Band', 'Banded Push Up', 'Band Chest Press')

# ── BACK ─────────────────────────────────────────────────────────────────────
add('Back', 'Barbell', 'Barbell Row', 'Pendlay Row', 'Yates Row', 'Barbell Shrug',
    'T Bar Row', 'Barbell Deadlift', 'Sumo Deadlift', 'Rack Pull', 'Trap Bar Deadlift')
add('Back', 'Dumbbell', 'Single Arm Dumbbell Row', 'Chest Supported Dumbbell Row',
    'Dumbbell Shrug', 'Dumbbell Pullover to Row')
add('Back', 'Cable', 'Straight Arm Pulldown', 'Single Arm Cable Row', 'Cable Shrug',
    'Half Kneeling Cable Pulldown', 'Reverse Grip Cable Row')
add('Back', 'Machine', 'Assisted Chin Up', 'Reverse Grip Pulldown', 'Machine Pullover',
    'Machine Shrug', 'Seated Row Machine')
add('Back', 'Plate-loaded', 'Plate Loaded Row', 'Plate Loaded Pulldown',
    'Hammer Strength Row', 'Hammer Strength High Row', 'Iso Lateral Row')
add('Back', 'Smith machine', 'Smith Machine Row')
add('Back', 'Bodyweight', 'Chin Up', 'Neutral Grip Pull Up', 'Wide Grip Pull Up',
    'Weighted Pull Up', 'Inverted Row', 'Ring Row')
add('Back', 'Band', 'Banded Pulldown', 'Banded Row')

# ── SHOULDERS ────────────────────────────────────────────────────────────────
add('Shoulders', 'Barbell', 'Barbell Overhead Press', 'Standing Barbell Press',
    'Push Press', 'Barbell Upright Row', 'Behind the Neck Press')
add('Shoulders', 'Dumbbell', 'Arnold Press', 'Seated Dumbbell Shoulder Press',
    'Dumbbell Front Raise', 'Dumbbell Rear Delt Fly', 'Dumbbell Upright Row',
    'Dumbbell Y Raise')
add('Shoulders', 'Cable', 'Leaning Cable Lateral Raise', 'Cable Upright Raise', 'Cable Front Raise',
    'Cable Rope Face Pull', 'Single Arm Cable Lateral Raise', 'Cable External Rotation')
add('Shoulders', 'Machine', 'Machine Rear Delt Fly', 'Machine Overhead Press')
add('Shoulders', 'Plate-loaded', 'Plate Loaded Shoulder Press', 'Hammer Strength Shoulder Press')
add('Shoulders', 'Smith machine', 'Smith Machine Shoulder Press')
add('Shoulders', 'Band', 'Band Pull Apart', 'Banded External Rotation', 'Banded Lateral Raise')
add('Shoulders', 'Bodyweight', 'Pike Push Up')

# ── BICEPS (and forearms) ────────────────────────────────────────────────────
add('Biceps', 'Barbell', 'EZ Bar Curl', 'Barbell Preacher Curl', 'Barbell Drag Curl',
    'Barbell Wrist Curl')
add('Biceps', 'Dumbbell', 'Dumbbell Concentration Curl', 'Dumbbell Preacher Curl',
    'Dumbbell Spider Curl', 'Dumbbell Zottman Curl', 'Dumbbell Wrist Curl',
    'Dumbbell Reverse Wrist Curl', 'Seated Dumbbell Curl')
add('Biceps', 'Cable', 'Cable Hammer Curl', 'Cable Preacher Curl', 'High Cable Curl',
    'Cable Reverse Curl')
add('Biceps', 'Machine', 'Machine Bicep Curl')
add('Biceps', 'Other', 'Farmer Carry', 'Plate Pinch Hold', 'Dead Hang')

# ── TRICEPS ──────────────────────────────────────────────────────────────────
add('Triceps', 'Barbell', 'Close Grip Bench Press', 'EZ Bar Skull Crusher',
    'Barbell JM Press')
add('Triceps', 'Dumbbell', 'Dumbbell Overhead Extension', 'Dumbbell Skull Crusher',
    'Dumbbell Kickback', 'Single Arm Dumbbell Extension')
add('Triceps', 'Cable', 'Cable Rope Pushdown', 'Single Arm Cable Pushdown',
    'Reverse Grip Pushdown', 'Cable Crossbody Extension')
add('Triceps', 'Machine', 'Machine Tricep Extension', 'Assisted Tricep Dip')
add('Triceps', 'Bodyweight', 'Bench Dip', 'Diamond Push Up', 'Tricep Dip')

# ── QUADS ────────────────────────────────────────────────────────────────────
add('Quads', 'Barbell', 'Back Squat', 'Front Squat', 'High Bar Back Squat',
    'Low Bar Back Squat', 'Pause Squat', 'Barbell Walking Lunge', 'Barbell Split Squat',
    'Barbell Step Up', 'Zercher Squat', 'Barbell Box Squat')
add('Quads', 'Dumbbell', 'Goblet Squat', 'Dumbbell Walking Lunge', 'Dumbbell Reverse Lunge',
    'Dumbbell Lateral Lunge', 'Dumbbell Curtsy Lunge', 'Dumbbell Front Squat',
    'Dumbbell Deficit Split Squat')
add('Quads', 'Machine', 'Leg Press (45 degree)', 'Horizontal Leg Press',
    'Single Leg Press', 'Pendulum Squat', 'V Squat Machine', 'Belt Squat')
add('Quads', 'Plate-loaded', 'Plate Loaded Hack Squat', 'Plate Loaded Leg Press',
    'Hammer Strength Leg Press')
add('Quads', 'Smith machine', 'Smith Machine Split Squat', 'Smith Machine Front Squat')
add('Quads', 'Bodyweight', 'Bodyweight Squat', 'Sissy Squat', 'Wall Sit', 'Spanish Squat')
add('Quads', 'Other', 'Sled Push', 'Prowler Push', 'Landmine Squat')

# ── HAMSTRINGS ───────────────────────────────────────────────────────────────
add('Hamstrings', 'Barbell', 'Conventional Deadlift', 'Stiff Leg Deadlift',
    'Deficit Deadlift', 'Barbell Good Morning', 'Snatch Grip Romanian Deadlift')
add('Hamstrings', 'Dumbbell', 'Dumbbell Stiff Leg Deadlift', 'Single Leg Dumbbell RDL',
    'Dumbbell Good Morning')
add('Hamstrings', 'Machine', 'Standing Leg Curl', 'Glute Ham Raise', 'Reverse Hyperextension',
    'Prone Leg Curl')
add('Hamstrings', 'Plate-loaded', 'Plate Loaded Leg Curl', 'Hammer Strength Leg Curl')
add('Hamstrings', 'Cable', 'Cable Romanian Deadlift', 'Cable Leg Curl')
add('Hamstrings', 'Bodyweight', 'Slider Leg Curl', 'Swiss Ball Leg Curl')
add('Hamstrings', 'Band', 'Banded Hamstring Curl')

# ── GLUTES ───────────────────────────────────────────────────────────────────
add('Glutes', 'Barbell', 'Barbell Glute Bridge', 'Barbell Frog Pump', 'Landmine Hip Thrust')
add('Glutes', 'Dumbbell', 'Dumbbell Hip Thrust', 'Dumbbell Glute Bridge',
    'Dumbbell Sumo Deadlift', 'Dumbbell Single Leg Hip Thrust')
add('Glutes', 'Cable', 'Cable Standing Abduction', 'Cable Sumo Squat', 'Cable Hip Extension')
add('Glutes', 'Machine', 'Seated Abduction Machine', 'Glute Drive Machine',
    'Standing Glute Kickback Machine', 'Hip Extension Machine')
add('Glutes', 'Plate-loaded', 'Plate Loaded Hip Thrust', 'Plate Loaded Glute Bridge')
add('Glutes', 'Bodyweight', 'Single Leg Glute Bridge', 'Frog Pump', 'Fire Hydrant',
    'Bodyweight Hip Thrust')
add('Glutes', 'Band', 'Banded Glute Bridge', 'Banded Monster Walk', 'Banded Clamshell')
add('Glutes', 'Kettlebell', 'Kettlebell Sumo Deadlift', 'Kettlebell Goblet Bridge')

# ── CALVES ───────────────────────────────────────────────────────────────────
add('Calves', 'Machine', 'Donkey Calf Raise', 'Standing Calf Raise Machine',
    'Seated Calf Raise Machine', 'Smith Machine Calf Raise')
add('Calves', 'Dumbbell', 'Dumbbell Standing Calf Raise', 'Single Leg Dumbbell Calf Raise')
add('Calves', 'Barbell', 'Barbell Calf Raise')
add('Calves', 'Bodyweight', 'Single Leg Calf Raise', 'Bent Knee Calf Raise',
    'Eccentric Calf Raise', 'Calf Raise off Step')
add('Calves', 'Plate-loaded', 'Plate Loaded Calf Raise')

# ── CORE ─────────────────────────────────────────────────────────────────────
add('Core', 'Bodyweight', 'Plank', 'Side Plank', 'Dead Bug', 'Bird Dog', 'Hollow Hold',
    'V Up', 'Toes to Bar', 'Mountain Climber', 'Reverse Crunch', 'Bicycle Crunch',
    'L Sit', 'Ab Wheel Rollout')
add('Core', 'Cable', 'Pallof Press', 'Cable Woodchop', 'Cable Reverse Woodchop',
    'Half Kneeling Pallof Press', 'Cable Side Bend')
add('Core', 'Dumbbell', 'Dumbbell Side Bend', 'Dumbbell Russian Twist', 'Suitcase Carry')
add('Core', 'Machine', 'Torso Rotation Machine')
add('Core', 'Kettlebell', 'Kettlebell Windmill', 'Kettlebell Turkish Get Up')
add('Core', 'Other', 'Landmine Rotation', 'Medicine Ball Slam', 'Medicine Ball Russian Twist')

# ── RUNNING STRENGTH ─────────────────────────────────────────────────────────
add('Running Strength', 'Bodyweight', 'Single Leg Calf Raise Isometric', 'Heel Walk',
    'Toe Walk', 'Single Leg Balance', 'Single Leg RDL Bodyweight',
    'Step Down Eccentric', 'Hip Airplane',
    'Single Leg Bridge Hold', 'Foot Doming (Short Foot)', 'Calf Raise Isometric Hold')
add('Running Strength', 'Band', 'Banded Tibialis Raise', 'Banded Hip Abduction Standing',
    'Banded Terminal Knee Extension', 'Banded Ankle Eversion', 'Banded Ankle Inversion')
add('Running Strength', 'Dumbbell', 'Weighted Step Down', 'Suitcase Carry Single Arm',
    'Dumbbell Single Leg Calf Raise Slow Eccentric')
add('Running Strength', 'Machine', 'Seated Tibialis Machine', 'Adductor Isometric Squeeze')
add('Running Strength', 'Other', 'Copenhagen Side Plank Bent Knee', 'Nordic Hamstring Eccentric',
    'Sled Drag Backward', 'Hill Sprint Strength')

# ── PLYOMETRIC ───────────────────────────────────────────────────────────────
add('Plyometric', 'Bodyweight', 'Box Jump', 'Depth Jump', 'Broad Jump', 'Pogo Hop',
    'Single Leg Pogo', 'Ankle Hop', 'Tuck Jump', 'Split Jump', 'Bounding',
    'Single Leg Bound', 'Lateral Bound', 'Skater Jump', 'Hurdle Hop',
    'Single Leg Box Jump', 'Countermovement Jump', 'Drop Landing', 'Squat Jump',
    'Continuous Long Jump', 'A Skip', 'B Skip', 'High Knees')
add('Plyometric', 'Other', 'Medicine Ball Chest Pass', 'Medicine Ball Overhead Throw',
    'Medicine Ball Rotational Throw', 'Kettlebell Swing Explosive')
add('Plyometric', 'Barbell', 'Hang Power Clean', 'Power Clean', 'Push Jerk', 'Barbell Jump Squat')

# ── emit ─────────────────────────────────────────────────────────────────────
def match_key(name):
    return re.sub(r'[^a-z0-9]+', ' ', name.lower()).strip()

rows, seen = [], set()
for cat, items in LIB.items():
    for name, equip in items:
        mk = match_key(name)
        if mk in seen:
            print(f"-- duplicate skipped: {name}", file=sys.stderr); continue
        seen.add(mk)
        esc = lambda s: s.replace("'", "''")
        # match_key is derived in SQL with the same expression the original seed
        # migration used, so the two can never drift apart.
        rows.append(f"  ('{esc(name)}','{esc(cat)}','{esc(equip)}')")

print(f"-- {len(rows)} exercises across {len(LIB)} categories", file=sys.stderr)
by_cat = {c: len(v) for c, v in LIB.items()}
for c, n in sorted(by_cat.items(), key=lambda kv: -kv[1]):
    print(f"--   {c}: {n}", file=sys.stderr)

print(",\n".join(rows))
