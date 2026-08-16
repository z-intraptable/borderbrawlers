import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { FeedProbe } from './dev/FeedProbe';

const container = document.getElementById('root');
if (container === null) throw new Error('#root no existe');

createRoot(container).render(
  <StrictMode>
    <FeedProbe />
  </StrictMode>,
);
