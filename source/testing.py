"""Prime number utilities."""


def primes_up_to(limit: int = 1000) -> list[int]:
    """Return all prime numbers up to and including `limit`.

    Uses the Sieve of Eratosthenes, which runs in O(n log log n) time.

    Args:
        limit: Upper bound (inclusive) for the search. Values below 2
            yield an empty list.

    Returns:
        Ascending list of primes <= limit.
    """
    if limit < 2:
        return []

    is_prime: list[bool] = [True] * (limit + 1)
    is_prime[0] = is_prime[1] = False

    for number in range(2, int(limit**0.5) + 1):
        if is_prime[number]:
            # Start at number*number: smaller multiples already marked.
            for multiple in range(number * number, limit + 1, number):
                is_prime[multiple] = False

    return [number for number, prime in enumerate(is_prime) if prime]


if __name__ == "__main__":
    result = primes_up_to(1000)
    print(f"Found {len(result)} primes up to 1000")
    print(result)
