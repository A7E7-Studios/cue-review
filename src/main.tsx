import React from 'react';
import ReactDOM from 'react-dom/client';
// Base styles load before the components' own stylesheets, as in Storybook (.storybook/preview.tsx).
import './ui/fonts.css';
import './styles.css';
import './Sidebar.css';
import './ui/polish.css';
import App from './App';
ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
