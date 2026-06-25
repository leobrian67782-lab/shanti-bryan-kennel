const mongoose = require('mongoose');

const puppySchema = new mongoose.Schema({
  name: { type: String, required: true },
  price: { type: Number, required: true },
  gender: { type: String, enum: ['Male', 'Female'], required: true },
  dateOfBirth: { type: Date, required: true },
  color: { type: String, required: true },
  weight: { type: String },
  status: { type: String, enum: ['Available', 'Reserved', 'Sold'], default: 'Available' },
  description: { type: String },
  photos: [{ type: String }],
  vaccinated: { type: Boolean, default: false },
  dewormed: { type: Boolean, default: false },
  microchipped: { type: Boolean, default: false },
  sireName: { type: String },
  damName: { type: String },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Puppy', puppySchema);