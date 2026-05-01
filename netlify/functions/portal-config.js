/**
 * GET /portal/api/config — public Clerk publishable key.
 * Hollow-shell version: also returns a flag indicating shell mode.
 */
exports.handler = async () => {
  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=300',
      'Access-Control-Allow-Origin': '*',
    },
    body: JSON.stringify({
      clerkPublishableKey: process.env.CLERK_PUBLISHABLE_KEY || '',
      shellMode: true,
      shellNotice: 'Connecting to data sources — coming soon.',
    }),
  };
};
