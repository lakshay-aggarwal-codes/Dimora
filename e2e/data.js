// What the e2e server seeds, shared with the specs.
const USERS = {
  password: "e2e-password-123",
  host: { username: "e2e_host", email: "e2e_host@example.com" },
  guest: { username: "e2e_guest", email: "e2e_guest@example.com" },
};

const LISTINGS = [
  {
    title: "E2E Instant Villa",
    description: "A bright villa near the beach that confirms bookings at once.",
    instantBook: true,
    price: 3000,
  },
  {
    title: "E2E Request Cottage",
    description: "A quiet cottage where the host answers each request herself.",
    instantBook: false,
    price: 2000,
  },
];

module.exports = { USERS, LISTINGS };
