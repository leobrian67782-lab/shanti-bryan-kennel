const mongoose = require('mongoose');

const settingsSchema = new mongoose.Schema({
  email: { type: String, default: 'info@shantibryankennel.com' },
  phone: { type: String, default: '' },
  statYears: { type: Number, default: 14 },
  statPuppies: { type: Number, default: 479 },
  statHealth: { type: Number, default: 95 },
  adminPasswordHash: { type: String, default: '' },
  updatedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Settings', settingsSchema);
