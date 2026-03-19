# Eval Fixture: merge-smoke

This fixture tests the merge pipeline under overlapping changes.

Two builders will each append a line to `shared.txt`. The merge queue must
drain successfully with both changes preserved — no content loss, no zombies.
