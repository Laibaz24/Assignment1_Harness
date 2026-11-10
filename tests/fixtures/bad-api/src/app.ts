// Deliberately non-compliant fixture: every standards rule must FAIL on this file
// with a location. Used by tests/unit/checks.test.ts. Never "fix" this file.
import express from 'express';

interface User {
  id: string;
  email: string;
}

const users: User[] = [];
// noUncheckedIndexedAccess makes this a compile error (User | undefined).
export const firstUser: User = users[0];

export const app = express();
app.use(express.json());

app.get('/user', (req, res) => {
  const limit = Number(req.query.limit);
  res.json(users.slice(0, limit));
});

app.post('/v1/users', (req, res) => {
  const body: any = req.body;
  if (!body.email) {
    res.status(400).json({ error: 'email required' });
    return;
  }
  users.push({ id: String(users.length + 1), email: body.email });
  res.json(users[users.length - 1]!);
});

app.delete('/v1/users/:id', (req, res) => {
  const idx = users.findIndex((u) => u.id === req.params.id);
  if (idx === -1) throw new Error('missing');
  users.splice(idx, 1);
  res.status(200).json({ ok: true });
});
