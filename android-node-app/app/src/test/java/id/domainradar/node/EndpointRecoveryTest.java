package id.domainradar.node;

import org.junit.Test;

import static org.junit.Assert.*;

/** Behavioral recovery tests: no live endpoints or real node credentials. */
public class EndpointRecoveryTest {
    private static void queueSwitch(EndpointRecovery recovery, String configured) {
        recovery.failed(recovery.beginPoll(configured), EndpointRecovery.Failure.TRANSPORT);
        recovery.failed(recovery.beginPoll(configured), EndpointRecovery.Failure.TRANSPORT);
    }

    @Test public void secondTransportFailureQueuesSwitchForNextPollOnly() {
        EndpointRecovery recovery = new EndpointRecovery();
        EndpointRecovery.Attempt first = recovery.beginPoll(EndpointRecovery.PRIMARY);
        assertEquals(EndpointRecovery.PRIMARY, first.origin);
        recovery.failed(first, EndpointRecovery.Failure.TRANSPORT);

        EndpointRecovery.Attempt second = recovery.beginPoll(EndpointRecovery.PRIMARY);
        assertEquals(EndpointRecovery.PRIMARY, second.origin);
        recovery.failed(second, EndpointRecovery.Failure.TRANSPORT);

        // A result upload or bootstrap observing current() must not replay its
        // request on another host merely because a switch has been queued.
        assertEquals(EndpointRecovery.PRIMARY,
                recovery.current(EndpointRecovery.PRIMARY).origin);
        assertEquals(second.generation,
                recovery.current(EndpointRecovery.PRIMARY).generation);

        EndpointRecovery.Attempt nextPoll = recovery.beginPoll(EndpointRecovery.PRIMARY);
        assertEquals(EndpointRecovery.ALTERNATE, nextPoll.origin);
        assertTrue(nextPoll.generation > second.generation);
    }

    @Test public void successfulAlternateStaysSelectedAcrossLaterPolls() {
        EndpointRecovery recovery = new EndpointRecovery();
        queueSwitch(recovery, EndpointRecovery.PRIMARY);
        EndpointRecovery.Attempt alternate = recovery.beginPoll(EndpointRecovery.PRIMARY);
        recovery.succeeded(alternate);

        for (int i = 0; i < 4; i++) {
            EndpointRecovery.Attempt next = recovery.beginPoll(EndpointRecovery.PRIMARY);
            assertEquals(EndpointRecovery.ALTERNATE, next.origin);
            assertEquals(alternate.generation, next.generation);
            recovery.succeeded(next);
        }
    }

    @Test public void successBreaksTheConsecutiveTransportFailureStreak() {
        EndpointRecovery recovery = new EndpointRecovery();
        recovery.failed(recovery.beginPoll(EndpointRecovery.PRIMARY),
                EndpointRecovery.Failure.TRANSPORT);
        recovery.succeeded(recovery.beginPoll(EndpointRecovery.PRIMARY));
        recovery.failed(recovery.beginPoll(EndpointRecovery.PRIMARY),
                EndpointRecovery.Failure.TRANSPORT);

        assertEquals(EndpointRecovery.PRIMARY,
                recovery.beginPoll(EndpointRecovery.PRIMARY).origin);
    }

    @Test public void nonTransportFailuresDoNotTriggerOrCompleteFallback() {
        EndpointRecovery.Failure[] failures = {
                EndpointRecovery.Failure.AUTH, EndpointRecovery.Failure.HTTP,
                EndpointRecovery.Failure.ACK, EndpointRecovery.Failure.TLS,
                EndpointRecovery.Failure.CANCELLED, EndpointRecovery.Failure.OTHER
        };
        for (EndpointRecovery.Failure failure : failures) {
            EndpointRecovery recovery = new EndpointRecovery();
            recovery.failed(recovery.beginPoll(EndpointRecovery.PRIMARY),
                    EndpointRecovery.Failure.TRANSPORT);
            recovery.failed(recovery.beginPoll(EndpointRecovery.PRIMARY), failure);
            recovery.failed(recovery.beginPoll(EndpointRecovery.PRIMARY),
                    EndpointRecovery.Failure.TRANSPORT);
            assertEquals(failure.name(), EndpointRecovery.PRIMARY,
                    recovery.beginPoll(EndpointRecovery.PRIMARY).origin);

            // Repeated rejected authentication, malformed ACK, TLS or HTTP
            // responses are not evidence that another origin should receive it.
            for (int i = 0; i < 4; i++) {
                recovery.failed(recovery.beginPoll(EndpointRecovery.PRIMARY), failure);
            }
            assertEquals(failure.name(), EndpointRecovery.PRIMARY,
                    recovery.beginPoll(EndpointRecovery.PRIMARY).origin);
        }
    }

    @Test public void reconnectInvalidatesOldAttemptAndClearsQueuedSwitch() {
        EndpointRecovery recovery = new EndpointRecovery();
        queueSwitch(recovery, EndpointRecovery.PRIMARY);
        EndpointRecovery.Attempt old = recovery.current(EndpointRecovery.PRIMARY);
        recovery.reconnect();
        EndpointRecovery.Attempt fresh = recovery.beginPoll(EndpointRecovery.PRIMARY);
        assertEquals(EndpointRecovery.PRIMARY, fresh.origin);
        assertTrue(fresh.generation > old.generation);

        recovery.failed(old, EndpointRecovery.Failure.TRANSPORT);
        recovery.failed(old, EndpointRecovery.Failure.TRANSPORT);
        assertEquals(EndpointRecovery.PRIMARY,
                recovery.beginPoll(EndpointRecovery.PRIMARY).origin);
    }

    @Test public void manualReconnectKeepsWorkingAlternate() {
        EndpointRecovery recovery = new EndpointRecovery();
        queueSwitch(recovery, EndpointRecovery.PRIMARY);
        EndpointRecovery.Attempt alternate = recovery.beginPoll(EndpointRecovery.PRIMARY);
        recovery.succeeded(alternate);
        recovery.reconnect();

        EndpointRecovery.Attempt fresh = recovery.beginPoll(EndpointRecovery.PRIMARY);
        assertEquals(EndpointRecovery.ALTERNATE, fresh.origin);
        assertTrue(fresh.generation > alternate.generation);
    }

    @Test public void staleSuccessCannotEraseCurrentRouteFailureStreak() {
        EndpointRecovery recovery = new EndpointRecovery();
        EndpointRecovery.Attempt oldPrimary = recovery.beginPoll(EndpointRecovery.PRIMARY);
        recovery.failed(oldPrimary, EndpointRecovery.Failure.TRANSPORT);
        recovery.failed(recovery.beginPoll(EndpointRecovery.PRIMARY),
                EndpointRecovery.Failure.TRANSPORT);
        EndpointRecovery.Attempt alternate = recovery.beginPoll(EndpointRecovery.PRIMARY);
        recovery.failed(alternate, EndpointRecovery.Failure.TRANSPORT);

        recovery.succeeded(oldPrimary);
        recovery.failed(recovery.beginPoll(EndpointRecovery.PRIMARY),
                EndpointRecovery.Failure.TRANSPORT);
        assertEquals(EndpointRecovery.PRIMARY,
                recovery.beginPoll(EndpointRecovery.PRIMARY).origin);
    }

    @Test public void staleFailureCannotFlipTheNewRoute() {
        EndpointRecovery recovery = new EndpointRecovery();
        EndpointRecovery.Attempt oldPrimary = recovery.beginPoll(EndpointRecovery.PRIMARY);
        queueSwitch(recovery, EndpointRecovery.PRIMARY);
        EndpointRecovery.Attempt alternate = recovery.beginPoll(EndpointRecovery.PRIMARY);
        recovery.succeeded(alternate);
        recovery.failed(oldPrimary, EndpointRecovery.Failure.TRANSPORT);
        recovery.failed(oldPrimary, EndpointRecovery.Failure.TRANSPORT);

        assertEquals(EndpointRecovery.ALTERNATE,
                recovery.beginPoll(EndpointRecovery.PRIMARY).origin);
    }

    @Test public void customEndpointChangeDiscardsOldFallbackAndCallbacks() {
        EndpointRecovery recovery = new EndpointRecovery();
        queueSwitch(recovery, EndpointRecovery.PRIMARY);
        EndpointRecovery.Attempt old = recovery.current(EndpointRecovery.PRIMARY);
        String custom = "https://customer-api.example/control";
        EndpointRecovery.Attempt next = recovery.beginPoll(custom);
        assertEquals(custom, next.origin);
        assertEquals("configured", next.label);
        assertTrue(next.generation > old.generation);

        recovery.failed(old, EndpointRecovery.Failure.TRANSPORT);
        recovery.succeeded(old);
        for (int i = 0; i < 6; i++) {
            recovery.failed(recovery.beginPoll(custom), EndpointRecovery.Failure.TRANSPORT);
            assertEquals(custom, recovery.current(custom).origin);
        }
    }

    @Test public void onlyExactApprovedHttpsOriginsJoinTheFallbackPair() {
        String[] custom = {
                "https://pentagon.quest.evil.example",
                "https://pentagon.quest@evil.example",
                "https://user@pentagon.quest",
                "https://pentagon.quest:444",
                "http://pentagon.quest",
                "https://pentagon.quest/api",
                "https://pentagon.quest?target=elsewhere",
                "https://pentagon.quest#fragment",
                "https://127.0.0.1",
                "https://unrelated.example",
                "not a URL"
        };
        for (String configured : custom) {
            EndpointRecovery recovery = new EndpointRecovery();
            for (int i = 0; i < 4; i++) {
                EndpointRecovery.Attempt attempt = recovery.beginPoll(configured);
                assertEquals(configured, configured, attempt.origin);
                assertEquals(configured, "configured", attempt.label);
                recovery.failed(attempt, EndpointRecovery.Failure.TRANSPORT);
            }
            assertEquals(configured, configured, recovery.beginPoll(configured).origin);
        }
    }

    @Test public void approvedOriginCanonicalizationPreservesConfiguredStartingHost() {
        String[][] cases = {
                {"HTTPS://PENTAGON.QUEST:443/", EndpointRecovery.ALTERNATE, "pentagon"},
                {" https://pentagon-web-production.up.railway.app/ ", EndpointRecovery.PRIMARY, "railway"}
        };
        for (String[] example : cases) {
            EndpointRecovery recovery = new EndpointRecovery();
            EndpointRecovery.Attempt attempt = recovery.beginPoll(example[0]);
            assertEquals(example[1], attempt.origin);
            assertEquals(example[2], attempt.label);
        }
    }

    @Test public void blankConfigurationUsesDefaultWithoutChangingCustomDefaults() {
        for (String configured : new String[]{null, "", "   "}) {
            EndpointRecovery recovery = new EndpointRecovery();
            assertEquals(EndpointRecovery.PRIMARY, recovery.beginPoll(configured).origin);
        }
        EndpointRecovery recovery = new EndpointRecovery();
        assertEquals("https://custom.example", recovery.beginPoll(" https://custom.example/ ").origin);
    }
}
