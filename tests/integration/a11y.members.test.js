// P18-T03: axe-core on the pages that need a signed-in member, rendered through
// the real layout with realistic view models (no database). Each page type is
// audited in its main states. Colour contrast is checked separately.
const {
  renderPage,
  audit,
  describe: show,
  member,
  admin,
} = require("../helpers/a11y");

const clean = async (view, locals, options) => {
  const html = await renderPage(view, locals, options);
  const violations = await audit(html);
  if (violations.length)
    throw new Error(
      `${view}: axe found ${violations.length} problem(s):\n${show(violations)}`,
    );
};

const NOW = new Date("2026-10-20T06:00:00Z");
const day = (s) => new Date(`${s}T00:00:00Z`);

describe("axe: account and member pages", () => {
  test("account settings, with and without blockers", async () => {
    await clean("account/index.ejs", {
      pageTitle: "Account settings",
      blockers: [],
      passwordMin: 10,
    });
    await clean("account/index.ejs", {
      pageTitle: "Account settings",
      passwordMin: 10,
      blockers: [
        {
          code: "guest_confirmed",
          message: "You have 1 confirmed stay that has not ended.",
        },
      ],
    });
  });
  test("edit profile, with an error", async () => {
    const base = {
      pageTitle: "Edit profile",
      account: { id: member._id, avatarUrl: "", displayName: "Asha" },
      values: { displayName: "Asha", bio: "" },
      errors: {},
      formError: "",
      limits: { avatarMb: 2, name: 40, bio: 500 },
    };
    await clean("account/profile.ejs", base);
    await clean("account/profile.ejs", {
      ...base,
      errors: { displayName: "Enter a name." },
      formError: "Please fix the problems below.",
    });
  });
  test("public profile, own and someone else's", async () => {
    const profile = {
      id: member._id,
      avatarUrl: "",
      displayName: "Asha",
      username: "asha",
      memberSince: "Mar 2025",
      bio: "I host two flats.",
      listingCount: 2,
      reviewCount: 1,
      hostCancellationCount: 0,
      reviews: [
        {
          listingId: "64b0f0f0f0f0f0f0f0f0aaaa",
          listingTitle: "Sea house",
          rating: 4,
          comment: "Lovely",
        },
      ],
    };
    await clean("users/profile.ejs", {
      pageTitle: "Asha",
      profile,
      isOwn: true,
    });
    await clean(
      "users/profile.ejs",
      { pageTitle: "Asha", profile, isOwn: false },
      { user: null },
    );
  });
  test("notifications, with items and empty", async () => {
    const items = [
      {
        id: "1",
        read: false,
        title: "Request accepted",
        body: "Your stay is confirmed.",
        url: "/trips/1",
        iso: "2026-10-19T10:00:00Z",
        when: "19 Oct",
      },
      {
        id: "2",
        read: true,
        title: "New message",
        body: "Hello",
        url: "/messages/2",
        iso: "2026-10-18T10:00:00Z",
        when: "18 Oct",
      },
    ];
    await clean("notifications/index.ejs", {
      pageTitle: "Notifications",
      items,
      show: "all",
      page: 1,
      totalPages: 2,
      total: 12,
      unread: 1,
    });
    await clean("notifications/index.ejs", {
      pageTitle: "Notifications",
      items: [],
      show: "unread",
      page: 1,
      totalPages: 1,
      total: 0,
      unread: 0,
    });
  });
  test("messages: the list, an empty list, and a conversation", async () => {
    const conversations = [
      {
        id: "c1",
        unread: true,
        otherName: "Ravi",
        listingTitle: "Sea house",
        lastFromMe: false,
        preview: "Is early check-in possible?",
        when: "19 Oct",
      },
    ];
    await clean("conversations/index.ejs", {
      pageTitle: "Messages",
      conversations,
      page: 1,
      totalPages: 1,
      total: 1,
    });
    await clean("conversations/index.ejs", {
      pageTitle: "Messages",
      conversations: [],
      page: 1,
      totalPages: 1,
      total: 0,
    });
    await clean("conversations/show.ejs", {
      pageTitle: "Conversation",
      conversation: {
        id: "c1",
        listingId: "64b0f0f0f0f0f0f0f0f0aaaa",
        listingTitle: "Sea house",
        otherName: "Ravi",
        reservationId: null,
        canReply: true,
      },
      messages: [
        {
          id: "m1",
          mine: false,
          iso: "2026-10-19T10:00:00Z",
          when: "19 Oct, 3:30 pm",
          body: "Is early check-in possible?",
        },
        {
          id: "m2",
          mine: true,
          iso: "2026-10-19T11:00:00Z",
          when: "19 Oct, 4:30 pm",
          body: "Yes, from 1 pm.",
        },
      ],
      hasMore: false,
      nextBefore: null,
      live: true,
    });
  });
  test("your reports, and the report form", async () => {
    await clean("reports/index.ejs", {
      pageTitle: "Your reports",
      reports: [
        {
          id: "r1",
          kindLabel: "Review",
          target: "A review",
          createdAt: NOW,
          reasonLabel: "Spam or an advert",
          status: "open",
          statusLabel: "Open",
          statusNote: "A moderator will look at it.",
        },
      ],
    });
    await clean("reports/index.ejs", {
      pageTitle: "Your reports",
      reports: [],
    });
    const form = {
      pageTitle: "Report listing",
      target: {
        kind: "listing",
        id: "64b0f0f0f0f0f0f0f0f0aaaa",
        label: "Sea house",
        url: "/listings/64b0f0f0f0f0f0f0f0f0aaaa",
      },
      kindLabel: "Listing",
      reasons: [
        { value: "scam", label: "Scam or fraud" },
        { value: "spam", label: "Spam or an advert" },
      ],
      limits: { details: 1000 },
      values: { reason: "", details: "" },
      error: null,
    };
    await clean("reports/new.ejs", form);
    await clean("reports/new.ejs", {
      ...form,
      error: "Choose a reason.",
      values: { reason: "", details: "x" },
    });
  });
});

describe("axe: trips and hosting pages", () => {
  const row = {
    id: "64b0f0f0f0f0f0f0f0f0c001",
    reference: "DIM-ABCD1234",
    listingTitle: "Sea house",
    city: "Goa",
    coverUrl: "",
    checkIn: "2 Nov 2026",
    checkOut: "5 Nov 2026",
    nights: 3,
    guests: 2,
    statusLabel: "Confirmed",
    tone: "success",
    totalMinor: 800000,
    currency: "INR",
    holdsUntil: null,
    reviewPrompt: "open",
  };
  test("your trips: a tab with stays, and an empty tab", async () => {
    const tabs = [
      { key: "upcoming", label: "Upcoming", count: 1 },
      { key: "pending", label: "Pending", count: 0 },
      { key: "past", label: "Past", count: 0 },
      { key: "cancelled", label: "Cancelled", count: 0 },
    ];
    await clean("trips/index.ejs", {
      pageTitle: "Your trips",
      tab: "upcoming",
      tabs,
      items: [
        row,
        {
          ...row,
          id: "64b0f0f0f0f0f0f0f0f0c002",
          statusLabel: "Waiting for the host",
          tone: "warning",
          holdsUntil: "21 Oct, 11:30 am",
          reviewPrompt: null,
        },
      ],
      page: 1,
      totalPages: 2,
      total: 12,
    });
    await clean("trips/index.ejs", {
      pageTitle: "Your trips",
      tab: "past",
      tabs,
      items: [],
      page: 1,
      totalPages: 1,
      total: 0,
    });
  });
  test("a booking page: confirmed with a review form, and pending", async () => {
    const trip = {
      id: "64b0f0f0f0f0f0f0f0f0c001",
      reference: "DIM-ABCD1234",
      status: "completed",
      statusLabel: "Completed",
      tone: "secondary",
      tab: "past",
      viewerRole: "guest",
      listing: {
        id: "64b0f0f0f0f0f0f0f0f0aaaa",
        title: "Sea house",
        city: "Goa",
        coverUrl: "",
        url: "/listings/64b0f0f0f0f0f0f0f0f0aaaa",
      },
      checkIn: "2 Nov 2026",
      checkInWeekday: "Mon",
      checkOut: "5 Nov 2026",
      checkOutWeekday: "Thu",
      checkInIso: "2026-11-02",
      checkOutIso: "2026-11-05",
      checkInTime: "14:00",
      checkOutTime: "11:00",
      nights: 3,
      guests: 2,
      lines: [
        { label: "₹2,500 × 3 nights", amount: "₹7,500", included: false },
        { label: "Cleaning fee", amount: "₹500", included: false },
      ],
      totalMinor: 800000,
      totalText: "₹8,000",
      avgPerNightText: "₹2,667",
      taxNote: "",
      houseRules: "No parties",
      noSpecialRules: false,
      cancellation: {
        label: "Flexible",
        terms: "Free cancellation until 24 hours before check-in.",
      },
      instantBook: false,
      holdsUntil: null,
      revealed: true,
      hostContact: {
        name: "Asha",
        email: "asha@example.com",
        profileUrl: "/users/1",
      },
      guestName: null,
      address: ["12 Beach Road", "Goa"],
      mapUrl: "https://www.openstreetmap.org/?mlat=15.5&mlon=73.8",
      declineReason: "",
      paymentSimulated: true,
      review: { state: "open", until: "5 Dec 2026" },
    };
    await clean("trips/show.ejs", { pageTitle: "Booking", trip });
    await clean("trips/show.ejs", {
      pageTitle: "Booking",
      trip: {
        ...trip,
        review: {
          state: "done",
          until: null,
          rating: 4,
          comment: "Lovely",
          hidden: true,
        },
      },
    });
    await clean("trips/show.ejs", {
      pageTitle: "Booking",
      trip: {
        ...trip,
        status: "pending",
        statusLabel: "Waiting for the host",
        tone: "warning",
        revealed: false,
        hostContact: null,
        address: null,
        mapUrl: null,
        holdsUntil: "21 Oct, 11:30 am",
        review: { state: "none", until: null },
      },
    });
  });
  test("booking requests (host inbox), with requests and empty", async () => {
    const guest = {
      name: "Ravi",
      profileUrl: "/users/2",
      memberSince: "Mar 2025",
      previousStays: 1,
    };
    const base = {
      id: "64b0f0f0f0f0f0f0f0f0c003",
      reference: "DIM-1111AAAA",
      status: "pending",
      listingTitle: "Sea house",
      checkIn: "2 Nov 2026",
      checkOut: "5 Nov 2026",
      nights: 3,
      guests: 2,
      guestTotal: "₹8,000",
      guest,
      canAnswer: true,
      expiresAtMs: NOW.getTime() + 5 * 3600000,
      expiresAtIso: new Date(NOW.getTime() + 5 * 3600000).toISOString(),
      expiresText: "5 h 0 min",
      expiresAt: "20 Oct, 5:00 pm",
      instantBook: false,
    };
    await clean("host/reservations.ejs", {
      pageTitle: "Booking requests",
      pending: [
        base,
        {
          ...base,
          id: "64b0f0f0f0f0f0f0f0f0c004",
          canAnswer: false,
          expiresText: null,
        },
      ],
      confirmed: [{ ...base, status: "confirmed", canAnswer: false }],
      truncated: true,
      limit: 50,
      problem: "This request has expired.",
    });
    await clean("host/reservations.ejs", {
      pageTitle: "Booking requests",
      pending: [],
      confirmed: [],
      truncated: false,
      limit: 50,
      problem: null,
    });
  });
  test("host overview, with data and with no listings", async () => {
    const data = {
      listingCount: 2,
      pending: { count: 3, soonestExpiry: NOW, capped: false },
      week: {
        days: 7,
        checkIns: 2,
        checkOuts: 1,
        upcomingCheckIns: [
          {
            id: "a1",
            title: "Sea house",
            guest: "Ravi",
            guests: 2,
            date: day("2026-10-22"),
          },
        ],
        upcomingCheckOuts: [
          {
            id: "a2",
            title: "Hill cabin",
            guest: "Meera",
            guests: 1,
            date: day("2026-10-24"),
          },
        ],
        capped: false,
      },
      earnings: {
        estimateMinor: 1300000,
        stays: 2,
        monthStart: day("2026-10-01"),
        capped: false,
      },
      occupancy: {
        days: 30,
        percent: 16,
        bookedNights: 8,
        blockedNights: 10,
        availableNights: 50,
        listings: 2,
      },
    };
    const {
      formatStayDate,
      formatInstant,
    } = require("../../src/services/trips");
    await clean("host/overview.ejs", {
      pageTitle: "Host overview",
      data,
      formatStayDate,
      formatInstant,
    });
    await clean("host/overview.ejs", {
      pageTitle: "Host overview",
      data: { ...data, listingCount: 0 },
      formatStayDate,
      formatInstant,
    });
  });
  test("the booking calendar of all listings", async () => {
    const { monthOverview } = require("../../src/services/hostCalendar");
    const chain = (rows) => {
      const q = {
        select: () => q,
        sort: () => q,
        limit: () => q,
        populate: () => q,
        lean: async () => rows,
      };
      return q;
    };
    const lid = "64b0f0f0f0f0f0f0f0f0a001";
    const rid = "64b0f0f0f0f0f0f0f0f0c001";
    const calendar = await monthOverview(
      {
        ListingModel: {
          find: () =>
            chain([{ _id: lid, title: "Sea house", status: "published" }]),
        },
        StayNightModel: {
          find: () =>
            chain([
              {
                listing: lid,
                date: day("2026-11-03"),
                source: { kind: "reservation", id: rid },
              },
              {
                listing: lid,
                date: day("2026-11-10"),
                source: { kind: "block", id: "b1" },
              },
            ]),
        },
        ReservationModel: {
          find: () =>
            chain([
              {
                _id: rid,
                status: "confirmed",
                guest: { _id: "g1", displayName: "Ravi" },
              },
            ]),
        },
      },
      member._id,
      "2026-11",
      { now: NOW },
    );
    await clean("host/overview-calendar.ejs", {
      pageTitle: "Booking calendar",
      calendar,
    });
  });
});

describe("axe: admin pages", () => {
  const opts = { user: admin, path: "/admin" };
  test("the admin pages", async () => {
    await clean("admin/index.ejs", { pageTitle: "Admin" }, opts);
    await clean(
      "admin/reports.ejs",
      {
        pageTitle: "Reports",
        result: {
          rows: [
            {
              id: "r1",
              kind: "review",
              kindLabel: "Review",
              target: "A review",
              reasonLabel: "Spam",
              reporter: "ann",
              status: "open",
              createdAt: NOW,
              resolvedAt: null,
              openOnTarget: 2,
            },
          ],
          page: 1,
          totalPages: 1,
          total: 1,
          status: "open",
          kind: "",
          openTotal: 1,
        },
      },
      opts,
    );
    await clean(
      "admin/reports.ejs",
      {
        pageTitle: "Reports",
        result: {
          rows: [],
          page: 1,
          totalPages: 1,
          total: 0,
          status: "open",
          kind: "",
          openTotal: 0,
        },
      },
      opts,
    );
    const page = {
      report: {
        id: "64b0f0f0f0f0f0f0f0f0d001",
        kindLabel: "Review",
        reasonLabel: "Spam",
        details: "ad",
        reporter: "ann",
        status: "open",
        createdAt: NOW,
        resolvedAt: null,
        resolvedBy: null,
        note: "",
      },
      target: {
        kind: "review",
        id: "64b0f0f0f0f0f0f0f0f0e001",
        rating: 1,
        comment: "Bad",
        author: "guest1",
        listingTitle: "Sea house",
        hidden: false,
        hiddenReason: "",
      },
      others: [
        {
          id: "r2",
          reasonLabel: "Spam",
          details: "",
          status: "open",
          reporter: "bob",
          createdAt: NOW,
        },
      ],
      openOthers: 1,
    };
    await clean("admin/report.ejs", { pageTitle: "Report", page }, opts);
    await clean(
      "admin/report.ejs",
      {
        pageTitle: "Report",
        page: {
          ...page,
          target: {
            ...page.target,
            hidden: true,
            hiddenReason: "Private data",
          },
        },
      },
      opts,
    );
    await clean(
      "admin/audit.ejs",
      {
        pageTitle: "Audit log",
        log: {
          rows: [
            {
              createdAt: NOW,
              actor: "64b0f0f0f0f0f0f0f0f0bbbb",
              actorLabel: "boss",
              action: "review.hide",
              targetType: "review",
              targetId: "x",
              reason: "Private data",
              details: { rating: 1 },
            },
          ],
          page: 1,
          totalPages: 1,
          total: 1,
        },
      },
      opts,
    );
  });
});

describe("axe: more admin pages", () => {
  const opts = { user: admin, path: "/admin" };
  const history = [
    {
      createdAt: NOW,
      actor: { username: "boss" },
      action: "user.suspend",
      reason: "Spam",
    },
  ];
  test("users: search, one account, and a suspended one", async () => {
    const u = {
      _id: "64b0f0f0f0f0f0f0f0f0aa01",
      username: "ann",
      displayName: "Ann",
      email: "ann@example.com",
      role: "member",
      status: "active",
      createdAt: NOW,
    };
    await clean(
      "admin/users.ejs",
      {
        pageTitle: "Users",
        result: {
          rows: [
            u,
            {
              ...u,
              _id: "64b0f0f0f0f0f0f0f0f0aa02",
              username: "bob",
              status: "suspended",
            },
          ],
          page: 1,
          totalPages: 2,
          total: 30,
          q: "an",
          status: "",
        },
      },
      opts,
    );
    await clean(
      "admin/users.ejs",
      {
        pageTitle: "Users",
        result: {
          rows: [],
          page: 1,
          totalPages: 1,
          total: 0,
          q: "zzz",
          status: "suspended",
        },
      },
      opts,
    );
    const summary = {
      user: u,
      activity: {
        listings: {
          total: 3,
          published: 1,
          draft: 1,
          unpublished: 1,
          suspended: 0,
        },
        reviewsWritten: 2,
      },
      reservations: { pending: 1, confirmed: 2 },
      history,
    };
    await clean(
      "admin/user.ejs",
      { pageTitle: "Account", summary, isSelf: false },
      opts,
    );
    await clean(
      "admin/user.ejs",
      {
        pageTitle: "Account",
        summary: {
          ...summary,
          user: { ...u, status: "suspended" },
          history: [],
        },
        isSelf: false,
      },
      opts,
    );
    await clean(
      "admin/user.ejs",
      { pageTitle: "Account", summary, isSelf: true },
      opts,
    );
  });
  test("listings: the queue and one listing, published and suspended", async () => {
    const r = {
      id: "64b0f0f0f0f0f0f0f0f0a001",
      title: "Sea house",
      place: "Goa",
      host: "asha",
      hostId: "64b0f0f0f0f0f0f0f0f0aaaa",
      status: "published",
      hiddenWithHost: false,
      openReports: 2,
      createdAt: NOW,
    };
    await clean(
      "admin/listings.ejs",
      {
        pageTitle: "Listings",
        result: {
          rows: [r, { ...r, status: "suspended", hiddenWithHost: true }],
          page: 1,
          totalPages: 1,
          total: 2,
          filter: "reported",
        },
      },
      opts,
    );
    await clean(
      "admin/listings.ejs",
      {
        pageTitle: "Listings",
        result: { rows: [], page: 1, totalPages: 1, total: 0, filter: "new" },
      },
      opts,
    );
    const s = {
      id: r.id,
      title: "Sea house",
      status: "published",
      deleted: false,
      host: {
        id: "64b0f0f0f0f0f0f0f0f0aaaa",
        username: "asha",
        status: "active",
      },
      place: "Goa",
      nightlyMinor: 250000,
      currency: "INR",
      photos: 4,
      reviewedAt: null,
      descriptionExcerpt: "A quiet house.",
    };
    const reports = [
      {
        reason: "Scam",
        reporter: "ann",
        createdAt: NOW,
        details: "Looks fake",
      },
    ];
    await clean(
      "admin/listing.ejs",
      { pageTitle: "Listing", page: { summary: s, reports, history } },
      opts,
    );
    await clean(
      "admin/listing.ejs",
      {
        pageTitle: "Listing",
        page: {
          summary: {
            ...s,
            status: "suspended",
            suspendedAt: NOW,
            suspendedBy: "boss",
            suspendReason: "Scam",
          },
          reports: [],
          history: [],
        },
      },
      opts,
    );
  });
});
