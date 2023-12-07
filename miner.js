const fs = require('fs');
const path = require('path');
const ethers = require('ethers');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');

// Set up your Polygon node information for connecting to the Polygon network
const provider = new ethers.providers.JsonRpcProvider('https://polygon-bor.publicnode.com');
// Your smart contract address and private key
const contractAddress = '0x4b7e197e8b6807c4ffb52ca7f0b56095d03c0b47';
const privateKey = 'xxx'; // Replace with your private key

// Read the ABI (Application Binary Interface) of the smart contract
const abiPath = path.join(__dirname, 'ABI', 'abi.json');
const contractABI = JSON.parse(fs.readFileSync(abiPath, 'utf8'));

// Create a wallet instance and connect it with the provider
const wallet = new ethers.Wallet(privateKey, provider);

// Create an instance of the smart contract
const contract = new ethers.Contract(contractAddress, contractABI, wallet);

// Check if a given hash satisfies the mining difficulty requirements
function isValidHash(hash) {
    return hash < "0x000000FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF";
}

// Function to start a mining thread with specified nonce range
function startMiningThread(startNonce, nonceRange, currentGlobalChallenge) {
    const worker = new Worker(__filename, {
        workerData: { startNonce, nonceRange, currentGlobalChallenge },
    });

    worker.on('message', (message) => {
        console.log(`Worker ${worker.threadId} message: ${message}`);
    });

    worker.on('error', (error) => {
        console.error(`Worker ${worker.threadId} error: ${error}`);
    });

    worker.on('exit', (code) => {
        if (code !== 0) {
            console.error(`Worker ${worker.threadId} exited with code ${code}`);
        }
    });

    return worker;
}

// Main mining function
async function mine() {
    while (true) {
        try {
            let currentGlobalChallenge = await contract.currentGlobalChallenge();

            // Number of mining threads
            const numThreads = 4;
            const range = 50000000;

            // Start mining threads
            const workers = [];
            for (let i = 0; i < numThreads; i++) {
                const worker = startMiningThread(i * range, range, currentGlobalChallenge);
                workers.push(worker);
            }

            // Listen for messages from worker threads
            for (const worker of workers) {
                worker.on('message', (message) => {
                    console.log(`Main thread received message from Worker ${worker.threadId}: ${message}`);
                });
            }

            // Wait for all worker threads to finish
            await Promise.all(workers.map((worker) => new Promise((resolve) => worker.on('exit', resolve))));

            console.log("All mining threads finished. Restarting mining in 10 seconds...");

            // Add a delay before restarting the mining process
            await new Promise(resolve => setTimeout(resolve, 10000));
        } catch (error) {
            console.error("Error in main mining process:", error);
        }
    }
}

// If it's the main thread, start the mining process
if (isMainThread) {
    mine();
}
// If it's a worker thread, perform mining in the specified nonce range
else {
    const { startNonce, nonceRange, currentGlobalChallenge } = workerData;
    mineInWorkerThread(startNonce, nonceRange, currentGlobalChallenge);
}

// Mining function for worker threads
async function mineInWorkerThread(startNonce, nonceRange, currentGlobalChallenge) {
    try {
        let nonce = startNonce;

        while (nonce < startNonce + nonceRange) {
            // Periodically check if the global challenge value has changed
            if (nonce % 100000 === 0) {
                const newChallenge = await contract.currentGlobalChallenge();
                if (newChallenge !== currentGlobalChallenge) {
                    console.log(`Worker ${workerData.startNonce / workerData.nonceRange}: Mining Process and resetting mining process...`);
                    currentGlobalChallenge = newChallenge;
                    nonce = startNonce;
                }
            }

            // Prepare data for mining
            const addressBytes = ethers.utils.arrayify(wallet.address);
            const challengeBytes = ethers.utils.arrayify(currentGlobalChallenge);
            const minerSpecificChallenge = ethers.utils.keccak256(ethers.utils.concat([challengeBytes, addressBytes]));
            const nonceBytes = ethers.utils.zeroPad(ethers.utils.arrayify(nonce), 32);

            // Compute the hash
            const hash = ethers.utils.keccak256(ethers.utils.concat([nonceBytes, ethers.utils.arrayify(minerSpecificChallenge), addressBytes]));

            // If a valid hash is found, try to submit it to the contract
            if (isValidHash(hash)) {
                console.log(`Worker ${workerData.startNonce / workerData.nonceRange}: Valid Nonce found: ${nonce}, comparing with the contract...`);
                const [message, contractHash] = await contract.debugSolution(nonce, wallet.address);
                if (hash === contractHash && message === "Solution is valid") {
                    console.log(`Worker ${workerData.startNonce / workerData.nonceRange}: Hash matches with contract: ${hash}`);
                    
                    // Use a high gas limit for mining transactions
                    const gasLimit = ethers.utils.hexlify(2000000);

                    // Use a dynamic adjustment strategy for gas price
                    const currentGasPrice = await provider.getGasPrice();
                    const increasedGasPrice = currentGasPrice.mul(ethers.BigNumber.from(5)).div(ethers.BigNumber.from(4));

                    // Ensure the gas price doesn't go too low
                    const finalGasPrice = increasedGasPrice.lt(ethers.utils.parseUnits("20", "gwei"))
                        ? ethers.utils.parseUnits("20", "gwei")
                        : increasedGasPrice;

                    console.log(`Worker ${workerData.startNonce / workerData.nonceRange}: Sending mining transaction, Nonce: ${nonce}, Hash: ${hash}, Gas Price: ${finalGasPrice}`);
                    // Send transaction
                    const tx = await contract.mint(nonce, wallet.address, {
                        gasLimit: gasLimit,
                        value: ethers.utils.parseUnits("0.06", "ether"),
                        gasPrice: finalGasPrice // Set dynamic gas price
                    });

                    console.log(`Worker ${workerData.startNonce / workerData.nonceRange}: Mining transaction sent, Transaction Hash: ${tx.hash}`);
                    await tx.wait();
                    
                    // Get updated balances after the transaction
                    const updatedMaticBalance = ethers.utils.formatEther(await wallet.getBalance());
                    const updatedPowcBalance = ethers.utils.formatEther(await contract.balanceOf(wallet.address));
                    
                    // Log updated balances
                    console.log(`Worker ${workerData.startNonce / workerData.nonceRange}: Updated Balances - MATIC: ${updatedMaticBalance} | POWC: ${updatedPowcBalance}`);
                    
                    // Mining successful, preparing for the next round...
                    console.log(`Worker ${workerData.startNonce / workerData.nonceRange}: Mining successful, preparing for next round...`);

                    // Reset nonce to startNonce to begin a new round
                    nonce = startNonce;
                } else {
                    console.log(`Worker ${workerData.startNonce / workerData.nonceRange}: Invalid or unmatched solution: ${message}`);
                }
            }

            // Increment nonce for the next iteration
            nonce++;
        }
    } catch (error) {
        console.error(`Worker ${workerData.startNonce / workerData.nonceRange}: Error during mining: `, error);
        parentPort.postMessage(`Error in Worker ${workerData.startNonce / workerData.nonceRange}: ${error.message}`);
        await new Promise(resolve => setTimeout(resolve, 10000));
    }
}
