const mongoose = require('mongoose');

const testimonialSchema = new mongoose.Schema({
  customerName: { type: String, required: true },
  location: { type: String },
  tag: { type: String },
  rating: { type: Number, min: 1, max: 5, default: 5 },
  message: { type: String, required: true },
  photo: { type: String },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Testimonial', testimonialSchema);