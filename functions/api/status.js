import {proxy} from '../_lib/proxy.js';
export const onRequestGet = context => proxy(context,'/api/status');
