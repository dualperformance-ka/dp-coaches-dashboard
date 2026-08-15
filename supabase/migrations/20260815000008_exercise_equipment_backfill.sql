-- Fill the equipment tag on the 52 originally-seeded exercises that the first
-- pass could not infer.
--
-- The original rule in 20260815000003 only matched names that NAMED their
-- implement ("Barbell Hip Thrust"), which most of Karl's own entries do not
-- ("Hack Squat", "Pec Dec", "Lat Pulldown").
--
-- Equipment drives the picker's secondary label, so a missing tag is cosmetic —
-- but a coach scanning for "what can this athlete actually use at their gym"
-- needs it populated to be useful.
--
-- Names are never touched. Ordered rules, first match wins.
--
-- Rollback: none needed — re-running 20260815000003 would leave these as they
-- are, and clearing them would only remove information.

begin;

update public.exercise_library
   set equipment = case
     when match_key ~ 'smith'                                            then 'Smith machine'
     when match_key ~ 'kettlebell'                                       then 'Kettlebell'
     when match_key ~ 'banded|^band '                                    then 'Band'
     when match_key ~ 'cable|pulley|pulldown|pushdown|rope|face pull'    then 'Cable'
     when match_key ~ 'barbell|^ez bar|skull crusher'                    then 'Barbell'
     when match_key ~ 'dumbbell'                                         then 'Dumbbell'
     -- Selectorised / pin-loaded plant: the machine names Karl's splits use
     -- without the word "machine" in them.
     when match_key ~ 'machine|pec dec|hack squat|leg press|leg extension|leg curl|hamstring curl|assisted|abduction|adduction|abductor|adductor|extension machine|crunch|chair'
                                                                          then 'Machine'
     -- Bar or bodyweight apparatus.
     when match_key ~ 'pull up|chin up|dip|hanging|knee raise|leg raise|plank|sit up|nordic|step up|step down|lunge|split squat|calf raise|back extension|balance|walk|hold|bridge|flexor|tibialis|isometric'
                                                                          then 'Bodyweight'
     else 'Other'
   end
 where equipment is null;

commit;
