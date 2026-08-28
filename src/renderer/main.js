/**
 * @file main.js
 * @description Renderer entry point — creates and mounts the Vue application.
 *
 * The `vue-win-mgr` stylesheet import below is not optional and its absence does
 * not look like a missing stylesheet. The library ships 81KB of CSS that does
 * all of the frame positioning; without it every window renders, correctly, at
 * the origin, on top of each other. The app boots, the theme applies, the
 * windows report themselves visible, and the result is an unreadable stack in
 * the top-left corner with nothing in the console to explain it.
 */

import { createApp } from 'vue';

// see the file header: this is what positions the frames
import 'vue-win-mgr/dist/style.css';

import App from './App.vue';
import './style.css';

createApp(App).mount('#app');
